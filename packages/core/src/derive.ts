import { TaskStatus } from "@cairn/contract";
import type {
  Actor,
  Event,
  HumanGate,
  Manifest,
  ManifestTask,
  Section,
  TaskEventType,
  TaskId,
  TraceWarning,
} from "@cairn/contract";
import {
  Array,
  DateTime,
  HashSet,
  Match,
  Option,
  Order,
  Record,
  String,
  Struct,
  pipe,
} from "effect";
import { initialTransition, transition } from "xstate";
import type { SnapshotFrom } from "xstate";

import { gateOf } from "./gates.ts";
import type { GateConfig } from "./gates.ts";
import { statusOf, taskMachine } from "./task-machine.ts";

/**
 * A manifest task as `derive` recomputes it: `status` is derived from the events, not the
 * manifest snapshot, `gate` is its effective gate, `events` are its events in the order they
 * were folded, and `waiting` says a task below it is `blocked_on_human`.
 */
export interface DerivedTask extends ManifestTask {
  readonly events: ReadonlyArray<Event>;
  readonly gate: HumanGate;
  readonly waiting: boolean;
}

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

const warning = (kind: TraceWarning["kind"], taskId: TaskId, message: string): TraceWarning => ({
  kind,
  message,
  sha: null,
  taskId,
});

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

/** One event through the machine. An event that leaves the status where it was is a warning. */
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
    onSome: (snapshot) => ({ snapshot, warnings: folded.warnings }),
  });
};

/**
 * The task's effective gate: its own `humanGate` and what `gateOf` finds in the sections and
 * config now. A gate the manifest records is never dropped.
 */
const effectiveGate = (
  task: ManifestTask,
  sections: ReadonlyArray<Section>,
  config: GateConfig,
): HumanGate => {
  const detected = gateOf(task, sections, config, []);
  return {
    reasons: Array.dedupe(Array.appendAll(task.humanGate.reasons, detected.reasons)),
    required: task.humanGate.required || detected.required,
  };
};

interface Walk {
  readonly next: Option.Option<TaskId>;
  readonly seen: HashSet.HashSet<TaskId>;
}

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
 * Recomputes every task from scratch (see `spec.status.derivation`). Each task's events are sorted
 * with `EventOrder` and folded through the task machine under its effective gate. What the
 * machine ignores, and an event for a task the manifest does not have, is a warning, never an
 * error. A `pending` task with a `blocked_on_human` task below it is `waiting`.
 */
export const derive = (
  manifest: Manifest,
  sections: ReadonlyArray<Section>,
  config: GateConfig,
  events: ReadonlyArray<Event>,
): Derived => {
  const sorted = Array.sort(events, EventOrder);
  const byTask = Array.groupBy(sorted, (event) => event.taskId);
  const folded = Array.map(manifest.tasks, (task) => {
    const gate = effectiveGate(task, sections, config);
    const own = Option.getOrElse(Record.get(byTask, task.id), (): ReadonlyArray<Event> => []);
    const result = Array.reduce(
      own,
      { snapshot: initialTransition(taskMachine, { gated: gate.required, task })[0], warnings: [] },
      step,
    );
    return { events: own, gate, task, result };
  });
  const statuses = Record.fromIterableWith(folded, ({ result, task }) => [
    task.id,
    statusOf(result.snapshot),
  ]);
  const byId = Record.fromIterableBy(manifest.tasks, (task) => task.id);
  const isBlocked = (id: TaskId) =>
    Option.exists(Record.get(statuses, id), (status) => status === "blocked_on_human");
  const tasks = Array.map(folded, ({ events: own, gate, result, task }): DerivedTask => {
    const status = statusOf(result.snapshot);
    return Struct.assign(task, {
      events: own,
      gate,
      status,
      waiting: status === "pending" && Array.some(below(byId, task), isBlocked),
    });
  });
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
    warnings: Array.appendAll(
      Array.flatMap(folded, ({ result }) => result.warnings),
      unknown,
    ),
  };
};
