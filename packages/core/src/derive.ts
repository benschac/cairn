import { TaskId, TaskStatus, TraceCommit } from "@cairn/contract";
import type {
  Actor,
  Event,
  HumanGate,
  Manifest,
  ManifestTask,
  Section,
  Sha,
  TaskEventType,
  TraceTask,
  TraceWarning,
} from "@cairn/contract";
import {
  Array,
  DateTime,
  HashSet,
  Match,
  Option,
  Order,
  Predicate,
  Record,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";
import { initialTransition, transition } from "xstate";
import type { SnapshotFrom } from "xstate";

import { gateOf } from "./gates.ts";
import { indexOf } from "./relation-index.ts";
import type { GateConfig, GateItem } from "./gates.ts";
import { statusOf, taskMachine } from "./task-machine.ts";

/**
 * A commit as git shows it: what the trace shows of it, its `Cairn-Task` trailer (`null` when it
 * has none), the task branch it was read from (`parent..branch`, `null` for a commit read only
 * from `baseBranch`, such as a squash merge), and whether `baseBranch` reaches it. One entry per
 * sha.
 */
export const GitCommit = TraceCommit.pipe(
  Schema.fieldsAssign({
    branch: Schema.NullOr(Schema.String),
    onBase: Schema.Boolean,
    taskId: Schema.NullOr(TaskId),
  }),
);
export type GitCommit = typeof GitCommit.Type;

/**
 * A manifest task as `derive` recomputes it: `status` is derived from the events and git, not the
 * manifest snapshot, `gate` is its effective gate, `commits` are the commits that carry its
 * trailer, `events` are its events in the order they were folded, and `waiting` says a task below
 * it is `blocked_on_human`.
 */
export type DerivedTask = TraceTask;

/** What `derive` returns: every manifest task in manifest order, and what the machine ignored. */
export interface Derived {
  readonly tasks: ReadonlyArray<DerivedTask>;
  readonly warnings: ReadonlyArray<TraceWarning>;
}

type Snapshot = SnapshotFrom<typeof taskMachine>;

const statusRank = (status: TaskStatus): number =>
  Option.getOrElse(
    Array.findFirstIndex(TaskStatus.literals, (literal) => literal === status),
    () => 0,
  );

/**
 * Events by `ts`, then by status in lifecycle order, then by actor, so the order of lines in
 * `events.jsonl` never matters. The task and the detail, a missing one first, break any tie left,
 * so two lines compare equal only when they are the same line.
 */
export const EventOrder: Order.Order<Event> = Order.combineAll([
  Order.mapInput(DateTime.Order, (event: Event) => event.ts),
  Order.mapInput(Order.Number, (event: Event) => statusRank(event.status)),
  Order.mapInput(Order.String, (event: Event) => event.actor),
  Order.mapInput(Order.String, (event: Event) => event.taskId),
  Order.mapInput(Option.makeOrder(Order.String), (event: Event) =>
    Option.fromUndefinedOr(event.detail),
  ),
]);

const isHuman = (actor: Actor): boolean => String.startsWith("human:")(actor);

/**
 * The machine event an event line sends, from the status the task is in. `done` approves only a
 * task in `blocked_on_human` and only from a human; otherwise it is a `finish`, which the
 * machine turns into `blocked_on_human` for a gated task. A `pending` line sends nothing.
 */
const machineEventOf = (event: Event, current: TaskStatus): Option.Option<TaskEventType> =>
  Match.value(event.status).pipe(
    Match.when("pending", () => Option.none()),
    Match.when("running", () => Option.some("start" as const)),
    Match.when("done", () =>
      Option.some(
        current === "blocked_on_human" && isHuman(event.actor)
          ? ("approve" as const)
          : ("finish" as const),
      ),
    ),
    Match.when("blocked_on_human", () => Option.some("finish" as const)),
    Match.when("failed", () => Option.some("fail" as const)),
    Match.when("landed", () => Option.some("land" as const)),
    Match.exhaustive,
  );

const warning = (
  kind: TraceWarning["kind"],
  taskId: TaskId | null,
  message: string,
  sha: Sha | null = null,
): TraceWarning => ({ kind, message, sha, taskId });

const short = (sha: Sha): string => String.slice(0, 7)(sha);

const at = (event: Event): string => DateTime.formatIso(event.ts);

/** The warning for an event the machine ignored in `current`. */
const ignored = (event: Event, current: TaskStatus): TraceWarning =>
  event.status === "done" && current === "blocked_on_human" && !isHuman(event.actor)
    ? warning(
        "non-human-approval",
        event.taskId,
        `${event.taskId}: ${event.actor} reported done at ${at(event)}, but only a human: actor can approve a task in blocked_on_human`,
      )
    : warning(
        "illegal-transition",
        event.taskId,
        `${event.taskId}: ${event.status} from ${current} by ${event.actor} at ${at(event)} is not a transition; ignored`,
      );

interface Folded {
  readonly snapshot: Snapshot;
  readonly warnings: ReadonlyArray<TraceWarning>;
}

/**
 * A gated task lands from any status, but only `done` says a human approved it: a gated task
 * reaches `done` only through `approve`. A gated task that lands from anywhere else still lands,
 * with a warning that says how it landed and names the commit, or `null` for a `landed` line.
 */
const unapproved = (
  before: Snapshot,
  landing: string,
  sha: Sha | null,
): ReadonlyArray<TraceWarning> => {
  const current = statusOf(before);
  const { gated, task } = before.context;
  return gated && current !== "done"
    ? [
        warning(
          "landed-without-approval",
          task.id,
          `${task.id}: ${landing} while the task was ${current}, with no human approval; it landed`,
          sha,
        ),
      ]
    : [];
};

/**
 * One event through the machine. An event that leaves the status where it was is a warning, and so
 * is a `landed` line that lands a gated task no human approved.
 */
const step = (folded: Folded, event: Event): Folded => {
  const current = statusOf(folded.snapshot);
  const next = pipe(
    machineEventOf(event, current),
    Option.map((type) => transition(taskMachine, folded.snapshot, { type })[0]),
    Option.filter((snapshot) => statusOf(snapshot) !== current),
  );
  return Option.match(next, {
    onNone: () => ({
      snapshot: folded.snapshot,
      warnings: Array.append(folded.warnings, ignored(event, current)),
    }),
    onSome: (snapshot) => ({
      snapshot,
      warnings:
        statusOf(snapshot) === "landed"
          ? Array.appendAll(
              folded.warnings,
              unapproved(folded.snapshot, `${event.actor} reported landed at ${at(event)}`, null),
            )
          : folded.warnings,
    }),
  });
};

/**
 * The task's effective gate: its own `humanGate` and what `gateOf` finds in the sections, the
 * config and the files its commits changed now. A gate the manifest records is never dropped.
 */
const effectiveGate = (
  task: ManifestTask,
  sections: ReadonlyArray<Section>,
  config: GateConfig,
  commits: ReadonlyArray<GitCommit>,
  items: ReadonlyArray<GateItem>,
): HumanGate => {
  const detected = gateOf(
    task,
    sections,
    config,
    Array.dedupe(Array.flatMap(commits, ({ files }) => files)),
    items,
  );
  return {
    reasons: Array.dedupe(Array.appendAll(task.humanGate.reasons, detected.reasons)),
    required: task.humanGate.required || detected.required,
  };
};

interface Walk {
  readonly next: Option.Option<TaskId>;
  readonly seen: HashSet.HashSet<TaskId>;
}

/**
 * Sends `land` when `baseBranch` reaches a commit that carries the task's trailer: its own commits
 * after a merge, or the commit a squash merge made. Git alone finishes a task, so it lands whatever
 * its status; a gated task no human approved lands with a warning that names the commit.
 */
const landOn = (folded: Folded, commits: ReadonlyArray<GitCommit>): Folded =>
  pipe(
    Array.findFirst(commits, ({ onBase }) => onBase),
    Option.filter(() => statusOf(folded.snapshot) !== "landed"),
    Option.match({
      onNone: () => folded,
      onSome: ({ sha }) => ({
        snapshot: transition(taskMachine, folded.snapshot, { type: "land" })[0],
        warnings: Array.appendAll(
          folded.warnings,
          unapproved(folded.snapshot, `${short(sha)} reached the base branch`, sha),
        ),
      }),
    }),
  );

/** The trailers `spec.contract.trailers` requires: a task, a session and at least one section. */
const hasTrailers = (commit: GitCommit): boolean =>
  Predicate.isNotNull(commit.taskId) &&
  Predicate.isNotNull(commit.session) &&
  Array.isReadonlyArrayNonEmpty(commit.sections);

/**
 * What the commits say that the machine cannot: a commit on a task branch without its trailers, and
 * a trailer for a task the manifest does not have.
 */
const commitWarnings = (
  commit: GitCommit,
  byId: Record.ReadonlyRecord<string, ManifestTask>,
  byBranch: Record.ReadonlyRecord<string, ManifestTask>,
): ReadonlyArray<TraceWarning> =>
  Array.getSomes([
    pipe(
      Option.fromNullOr(commit.branch),
      Option.filter(() => !hasTrailers(commit)),
      Option.map((branch) =>
        warning(
          "missing-trailers",
          Option.getOrNull(Option.map(Record.get(byBranch, branch), ({ id }) => id)),
          `${short(commit.sha)} on ${branch} is missing Cairn-Task, Cairn-Session or Cairn-Section trailers`,
          commit.sha,
        ),
      ),
    ),
    pipe(
      Option.fromNullOr(commit.taskId),
      Option.filter((id) => !Record.has(byId, id)),
      Option.map((id) =>
        warning(
          "unknown-task",
          id,
          `${id}: ${short(commit.sha)} carries a Cairn-Task trailer for a task the manifest does not have`,
          commit.sha,
        ),
      ),
    ),
  ]);

/** The tasks below a task in its stack, nearest first. A parent cycle stops at the first repeat. */
const below = (
  byId: Record.ReadonlyRecord<string, ManifestTask>,
  task: ManifestTask,
): ReadonlyArray<TaskId> =>
  Array.unfold<Walk, TaskId>(
    { next: Option.fromNullOr(task.parent), seen: HashSet.make(task.id) },
    ({ next, seen }) =>
      pipe(
        next,
        Option.filter((id) => !HashSet.has(seen, id)),
        Option.map((id) => [
          id,
          {
            next: pipe(
              Record.get(byId, id),
              Option.flatMap((parent) => Option.fromNullOr(parent.parent)),
            ),
            seen: HashSet.add(seen, id),
          },
        ]),
      ),
  );

/**
 * Recomputes every task from scratch (see `spec.status.derivation`). Commits are grouped by their
 * `Cairn-Task` trailer, and the files they change join the task's effective gate. Each task's
 * events are sorted with `EventOrder` and folded through the task machine under that gate, then
 * `land` is sent when `baseBranch` reaches a commit with its trailer, whatever the status. What the
 * machine ignores, an event or trailer for a task the manifest does not have, a commit on a task
 * branch without trailers and a gated task that landed without approval are warnings, never errors. A `pending` task with a
 * `blocked_on_human` task below it is `waiting`. Whether a task can start, what it waits on and
 * what waits on it come from the relation index over the derived statuses. `items` are the list items of the PRD, which gate a task that names or implements a human one.
 */
export const derive = (
  manifest: Manifest,
  sections: ReadonlyArray<Section>,
  config: GateConfig,
  events: ReadonlyArray<Event>,
  commits: ReadonlyArray<GitCommit>,
  items: ReadonlyArray<GateItem> = [],
): Derived => {
  const sorted = Array.sort(events, EventOrder);
  const byTask = Array.groupBy(sorted, (event) => event.taskId);
  const commitsByTask = Array.groupBy(
    Array.filter(commits, (commit): commit is GitCommit & { taskId: TaskId } =>
      Predicate.isNotNull(commit.taskId),
    ),
    ({ taskId }) => taskId,
  );
  const folded = Array.map(manifest.tasks, (task) => {
    const own = Option.getOrElse(Record.get(byTask, task.id), (): ReadonlyArray<Event> => []);
    const ownCommits = Option.getOrElse(
      Record.get(commitsByTask, task.id),
      (): ReadonlyArray<GitCommit> => [],
    );
    const gate = effectiveGate(task, sections, config, ownCommits, items);
    const result = landOn(
      Array.reduce(
        own,
        {
          snapshot: initialTransition(taskMachine, { gated: gate.required, task })[0],
          warnings: [],
        },
        step,
      ),
      ownCommits,
    );
    return { commits: ownCommits, events: own, gate, task, result };
  });
  const statuses = Record.fromIterableWith(folded, ({ result, task }) => [
    task.id,
    statusOf(result.snapshot),
  ]);
  const byId = Record.fromIterableBy(manifest.tasks, (task) => task.id);
  const isBlocked = (id: TaskId) =>
    Option.exists(Record.get(statuses, id), (status) => status === "blocked_on_human");
  const byBranch = Record.fromIterableBy(manifest.tasks, (task) => task.branch);
  const index = indexOf({ tasks: manifest.tasks });
  const derivedStatusOf = (id: TaskId): TaskStatus =>
    Option.getOrElse(Record.get(statuses, id), (): TaskStatus => "pending");
  const tasks = Array.map(
    folded,
    ({ commits: own, events: lines, gate, result, task }): DerivedTask => {
      const status = statusOf(result.snapshot);
      return Struct.assign(task, {
        commits: Array.map(own, (commit) => Struct.omit(commit, ["branch", "onBase", "taskId"])),
        events: lines,
        gate,
        statements: [],
        status,
        waiting: status === "pending" && Array.some(below(byId, task), isBlocked),
        canStart: index.canStart(task.id, derivedStatusOf),
        waitsOn: index.waitsOn(task.id, derivedStatusOf),
        waitedOnBy: index.waitedOnBy(task.id, derivedStatusOf),
      });
    },
  );
  const unknown = Array.map(
    Array.filter(sorted, (event) => !Record.has(byId, event.taskId)),
    (event) =>
      warning(
        "unknown-task",
        event.taskId,
        `${event.taskId}: ${event.status} at ${at(event)} is for a task the manifest does not have`,
      ),
  );
  return {
    tasks,
    warnings: Array.flatten([
      Array.flatMap(folded, ({ result }) => result.warnings),
      unknown,
      Array.flatMap(commits, (commit) => commitWarnings(commit, byId, byBranch)),
    ]),
  };
};
