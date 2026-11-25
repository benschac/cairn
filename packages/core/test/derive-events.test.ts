import { Event, Manifest, Section, TaskStatus } from "@cairn/contract";
import type { Actor, TaskId, TraceWarningKind } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, DateTime, Option, Order, Record, Schema, String, Struct, pipe } from "effect";

import { derive } from "../src/index.ts";
import type { Derived, DerivedTask, GateConfig } from "../src/index.ts";

const task = (id: string, n: string, parent: string | null, gated: boolean) => ({
  branch: `cairn-mvp/${n}-task`,
  commits: [],
  dependsOn: Option.match(Option.fromNullOr(parent), { onNone: () => [], onSome: (p) => [p] }),
  files: [`packages/core/src/${id}.ts`],
  humanGate: { reasons: gated ? ["path:**/migrations/**"] : [], required: gated },
  id,
  model: "sonnet",
  parent,
  prdSections: ["prd.orchestrator-contract"],
  reasoning: "low",
  sessions: [],
  specSections: [`spec.status.task-${id}`],
  status: "pending",
  title: `Task ${id}`,
  worktree: null,
});

/** A stack t1 <- t2 <- t3 where only t1 is gated, and t4 on a stack of its own. */
const manifest = Schema.decodeUnknownSync(Manifest)({
  baseBranch: "main",
  feature: "cairn-mvp",
  tasks: [
    task("t1", "01", null, true),
    task("t2", "02", "t1", false),
    task("t3", "03", "t2", false),
    task("t4", "04", null, false),
  ],
  version: 1,
});

/** The tasks below each one in its stack, written out from the manifest above. */
const BELOW: Record.ReadonlyRecord<string, ReadonlyArray<string>> = {
  t1: [],
  t2: ["t1"],
  t3: ["t2", "t1"],
  t4: [],
};
const GATED = "t1";
const HUMAN = "human:ben";
const AGENT = "agent:codex";
const UNKNOWN = "t9";
const IDS = ["t1", "t2", "t3", "t4"] as const;
const noPaths: GateConfig = { humanPaths: [] };

/** Every call goes through here, so a new input to `derive` changes one line. */
const run = (
  events: ReadonlyArray<Event>,
  sections: ReadonlyArray<Section> = [],
  config: GateConfig = noPaths,
): Derived => derive(manifest, sections, config, events, []);

const taskOf = (derived: Derived, id: string): DerivedTask =>
  Option.getOrThrow(Array.findFirst(derived.tasks, (derivedTask) => derivedTask.id === id));

const kindsOf = (derived: Derived, id: string): ReadonlyArray<TraceWarningKind> =>
  Array.map(
    Array.filter(derived.warnings, (warning) => warning.taskId === id),
    (warning) => warning.kind,
  );

/** What an orchestrator, an agent or a human writes on one line of `events.jsonl`. */
interface Line {
  readonly actor: Actor;
  readonly detail?: string;
  readonly second: number;
  readonly status: TaskStatus;
  readonly taskId: string;
}

const eventOf = (line: Line): Event => {
  const fields = {
    actor: line.actor,
    status: line.status,
    taskId: line.taskId,
    ts: DateTime.formatIso(DateTime.makeUnsafe(line.second * 1000)),
  };
  return Schema.decodeSync(Event)(
    Option.match(Option.fromUndefinedOr(line.detail), {
      onNone: () => fields,
      onSome: (detail) => Struct.assign(fields, { detail }),
    }),
  );
};

const line = (
  taskId: string,
  status: TaskStatus,
  second: number,
  actor: Actor = "orchestrator",
): Event => eventOf({ actor, second, status, taskId });

const ActorPool = Schema.Literals(["orchestrator", HUMAN, AGENT]);
const ReportedStatus = TaskStatus;
const AnyTask = Schema.Literals(["t1", "t2", "t3", "t4", UNKNOWN]);
/** A sort key that puts the generated lines in another order. */
const Shuffle = Schema.Int;

const Lines = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Array(Schema.Struct(fields)).check(Schema.isMinLength(8), Schema.isMaxLength(40));

/** Lines over two seconds for a few tasks, two of them unknown, so many share a `ts` and a task. */
const CrowdedLines = Lines({
  actor: ActorPool,
  detail: Schema.optionalKey(Schema.Literals(["", "retry", "review"])),
  second: Schema.Int.check(Schema.isBetween({ maximum: 1, minimum: 0 })),
  shuffle: Shuffle,
  status: ReportedStatus,
  taskId: Schema.Literals([GATED, "t4", UNKNOWN, "t10"]),
});

/** Lines one second apart once `timed` numbers them in the order they were written. */
const WrittenLines = (actor: Schema.Codec<Actor>, taskId: Schema.Codec<string>) =>
  Lines({ actor, shuffle: Shuffle, status: ReportedStatus, taskId });

const timed = <A extends object>(lines: ReadonlyArray<A>) =>
  Array.map(lines, (fields, second) => Struct.assign(fields, { second }));

const shuffled = <A extends { readonly shuffle: number }>(lines: ReadonlyArray<A>) =>
  Array.sortWith(lines, ({ shuffle }) => shuffle, Order.Number);

it.prop("the order of lines in events.jsonl never matters", [CrowdedLines], ([lines]) => {
  expect(run(Array.map(shuffled(lines), eventOf))).toStrictEqual(run(Array.map(lines, eventOf)));
});

it("lines that differ only in their task or in a missing or empty detail still sort one way", () => {
  const pairs: ReadonlyArray<readonly [Line, Line]> = [
    [
      { actor: "orchestrator", second: 1, status: "running", taskId: UNKNOWN },
      { actor: "orchestrator", second: 1, status: "running", taskId: "t10" },
    ],
    [
      { actor: "orchestrator", second: 1, status: "running", taskId: "t4" },
      { actor: "orchestrator", detail: "", second: 1, status: "running", taskId: "t4" },
    ],
  ];
  expect(
    Array.map(pairs, ([first, second]) => run([eventOf(second), eventOf(first)])),
  ).toStrictEqual(Array.map(pairs, ([first, second]) => run([eventOf(first), eventOf(second)])));
});

/**
 * The lifecycle written out from spec.status.derivation: for each reported status, the status a
 * task moves from and the one it moves to. A pair missing from the table is ignored.
 */
const lifecycle = (
  gated: boolean,
  actor: Actor,
): Record.ReadonlyRecord<TaskStatus, Record.ReadonlyRecord<string, TaskStatus>> => {
  const finished: TaskStatus = gated ? "blocked_on_human" : "done";
  return {
    blocked_on_human: { running: finished },
    done: String.startsWith("human:")(actor)
      ? { blocked_on_human: "done", running: finished }
      : { running: finished },
    failed: { running: "failed" },
    landed: {
      blocked_on_human: "landed",
      done: "landed",
      failed: "landed",
      pending: "landed",
      running: "landed",
    },
    pending: {},
    running: { failed: "running", pending: "running" },
  };
};

interface Modelled {
  readonly kinds: ReadonlyArray<TraceWarningKind>;
  readonly status: TaskStatus;
}

/** A gated task that lands from anywhere but `done` landed with no human approval. */
const unapproved = (gated: boolean, from: TaskStatus, to: TaskStatus) =>
  gated && to === "landed" && from !== "done";

const model = (gated: boolean, lines: ReadonlyArray<Line>): Modelled =>
  Array.reduce(lines, { kinds: [], status: "pending" }, (state: Modelled, { actor, status }) =>
    Option.match(Record.get(lifecycle(gated, actor)[status], state.status), {
      onNone: () => ({
        kinds: Array.append(
          state.kinds,
          status === "done" && state.status === "blocked_on_human"
            ? "non-human-approval"
            : "illegal-transition",
        ),
        status: state.status,
      }),
      onSome: (next) => ({
        kinds: unapproved(gated, state.status, next)
          ? Array.append(state.kinds, "landed-without-approval")
          : state.kinds,
        status: next,
      }),
    }),
  );

it.prop(
  "each task's status and warnings follow its lines through the lifecycle",
  [WrittenLines(ActorPool, AnyTask)],
  ([written]) => {
    const lines = timed(written);
    const derived = run(Array.map(shuffled(lines), eventOf));
    const linesOf = (id: string) => Array.filter(lines, (entry) => entry.taskId === id);
    expect(
      Array.map(IDS, (id) => ({
        kinds: kindsOf(derived, id),
        status: taskOf(derived, id).status,
      })),
    ).toStrictEqual(Array.map(IDS, (id) => model(id === GATED, linesOf(id))));
    expect(kindsOf(derived, UNKNOWN)).toStrictEqual(
      Array.map(linesOf(UNKNOWN), (): TraceWarningKind => "unknown-task"),
    );
  },
);

it.prop(
  "no orchestrator or agent line approves a gated task, and one that lands it is a warning",
  [WrittenLines(Schema.Literals(["orchestrator", AGENT, "agent:claude"]), Schema.Literal(GATED))],
  ([written]) => {
    const derived = run(Array.map(shuffled(timed(written)), eventOf));
    const status = taskOf(derived, GATED).status;
    expect(status).not.toBe("done");
    expect(status === "landed").toBe(
      Array.contains(kindsOf(derived, GATED), "landed-without-approval"),
    );
  },
);

it.prop(
  "a task is waiting exactly when it is pending and a task below it is blocked_on_human",
  [WrittenLines(ActorPool, Schema.Literals(["t1", "t2", "t3"]))],
  ([written]) => {
    const derived = run(Array.map(shuffled(timed(written)), eventOf));
    const blocked = (id: string) => taskOf(derived, id).status === "blocked_on_human";
    expect(Array.map(derived.tasks, ({ waiting }) => waiting)).toStrictEqual(
      Array.map(
        IDS,
        (id) =>
          taskOf(derived, id).status === "pending" &&
          Array.some(
            Option.getOrElse(Record.get(BELOW, id), () => []),
            blocked,
          ),
      ),
    );
  },
);

it("a gated task reported done waits in blocked_on_human until a human reports done", () => {
  const reported = [line(GATED, "running", 1), line(GATED, "done", 2)];
  const held = run(reported);
  expect(taskOf(held, GATED).status).toBe("blocked_on_human");
  expect(held.warnings).toStrictEqual([]);
  const approved = run(Array.append(reported, line(GATED, "done", 3, HUMAN)));
  expect(taskOf(approved, GATED).status).toBe("done");
  expect(approved.warnings).toStrictEqual([]);
});

it("an agent's done on a task in blocked_on_human is a warning, not an approval", () => {
  const derived = run([
    line(GATED, "running", 1),
    line(GATED, "blocked_on_human", 2),
    line(GATED, "done", 3, AGENT),
  ]);
  expect(taskOf(derived, GATED).status).toBe("blocked_on_human");
  expect(derived.warnings).toStrictEqual([
    {
      kind: "non-human-approval",
      message: `t1: ${AGENT} reported done at 1970-01-01T00:00:03.000Z, but only a human: actor can approve a task in blocked_on_human`,
      sha: null,
      taskId: "t1",
    },
  ]);
});

it("a line the lifecycle does not allow, or for an unknown task, is a warning", () => {
  const derived = run([
    line("t4", "pending", 1),
    line("t4", "done", 2),
    line("t4", "running", 3),
    line(UNKNOWN, "running", 4),
  ]);
  expect(taskOf(derived, "t4").status).toBe("running");
  expect(Array.map(derived.warnings, ({ kind, taskId }) => ({ kind, taskId }))).toStrictEqual([
    { kind: "illegal-transition", taskId: "t4" },
    { kind: "illegal-transition", taskId: "t4" },
    { kind: "unknown-task", taskId: UNKNOWN },
  ]);
});

it("a landed line lands a task from any status, and a gated one no human approved warns", () => {
  const derived = run([
    line("t4", "running", 1),
    line("t4", "landed", 2),
    line(GATED, "running", 1),
    line(GATED, "landed", 2),
  ]);
  expect(Array.map(["t4", GATED], (id) => taskOf(derived, id).status)).toStrictEqual([
    "landed",
    "landed",
  ]);
  expect(derived.warnings).toStrictEqual([
    {
      kind: "landed-without-approval",
      message: `t1: orchestrator reported landed at 1970-01-01T00:00:02.000Z while the task was running, with no human approval; it landed`,
      sha: null,
      taskId: "t1",
    },
  ]);
});

it("a task keeps only its own events, in the order they were folded", () => {
  const derived = run([line("t4", "done", 3), line("t1", "running", 1), line("t4", "running", 2)]);
  expect(Array.map(taskOf(derived, "t4").events, ({ status }) => status)).toStrictEqual([
    "running",
    "done",
  ]);
  expect(taskOf(derived, "t4").status).toBe("done");
});

const tagged = Schema.decodeSync(Section)({
  body: "<!-- human -->\n",
  human: true,
  id: "spec.status.task-t4",
  keys: { context: [], defers: [], dependsOn: [], files: [], implements: [] },
  level: 3,
  line: 1,
  parent: undefined,
  title: "Task t4",
});

const finished = [line("t4", "running", 1), line("t4", "done", 2)];

it("a human tag on a linked section gates a task the manifest left ungated", () => {
  const derived = run(finished, [tagged]);
  expect(taskOf(derived, "t4").status).toBe("blocked_on_human");
  expect(taskOf(derived, "t4").gate).toStrictEqual({ reasons: ["tag:human"], required: true });
  expect(taskOf(run(finished), "t4").status).toBe("done");
});

it("a high-trust path in the config gates a task that declares a matching file", () => {
  const derived = run(finished, [], { humanPaths: ["**/t4.ts"] });
  expect(taskOf(derived, "t4").status).toBe("blocked_on_human");
  expect(taskOf(derived, "t4").gate).toStrictEqual({ reasons: ["path:**/t4.ts"], required: true });
});

it("the manifest's own gate stays when nothing else gates the task", () => {
  expect(taskOf(run([]), GATED).gate).toStrictEqual({
    reasons: ["path:**/migrations/**"],
    required: true,
  });
});

const waitingIn = (derived: Derived): ReadonlyArray<TaskId> =>
  pipe(
    Array.filter(derived.tasks, (derivedTask) => derivedTask.waiting),
    Array.map(({ id }) => id),
  );

it("the stack above a gated task waits until a human approves it", () => {
  const blocked = [line(GATED, "running", 1), line(GATED, "done", 2)];
  expect(waitingIn(run(blocked))).toStrictEqual(["t2", "t3"]);
  expect(waitingIn(run(Array.append(blocked, line("t2", "running", 3))))).toStrictEqual(["t3"]);
  expect(waitingIn(run(Array.append(blocked, line(GATED, "done", 3, HUMAN))))).toStrictEqual([]);
});
