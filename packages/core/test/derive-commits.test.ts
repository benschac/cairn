import { Event, Manifest, Sha, TaskStatus } from "@cairn/contract";
import type { Actor, TraceWarningKind } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, DateTime, Option, Predicate, Record, Schema, String, Struct, pipe } from "effect";

import { GitCommit, derive } from "../src/index.ts";
import type { Derived, DerivedTask, GateConfig } from "../src/index.ts";

const MIGRATION = "db/migrations/001-init.sql";
const INFRA = "infra/main.tf";
const PLAIN = "packages/core/src/plain.ts";
const config: GateConfig = { humanPaths: ["**/migrations/**", "infra/**"] };
/** Which `config.humanPaths` pattern each generated file matches, written out by hand. */
const PATTERN_OF: Record.ReadonlyRecord<string, string> = {
  [INFRA]: "infra/**",
  [MIGRATION]: "**/migrations/**",
};

const task = (id: string, parent: string | null, gated: boolean) => ({
  branch: `cairn-mvp/0${String.slice(1)(id)}-task`,
  commits: [],
  dependsOn: Option.match(Option.fromNullOr(parent), { onNone: () => [], onSome: (p) => [p] }),
  files: [`packages/core/src/${id}.ts`],
  humanGate: { reasons: gated ? ["tag:human"] : [], required: gated },
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

/** A stack t1 <- t2 <- t3 and t4 on a stack of its own. The plan gates only `gatedTask`. */
const manifestWith = (gatedTask: string | null) =>
  Schema.decodeUnknownSync(Manifest)({
    baseBranch: "main",
    feature: "cairn-mvp",
    tasks: [
      task("t1", null, gatedTask === "t1"),
      task("t2", "t1", gatedTask === "t2"),
      task("t3", "t2", gatedTask === "t3"),
      task("t4", null, gatedTask === "t4"),
    ],
    version: 1,
  });
const manifest = manifestWith(null);
const IDS = ["t1", "t2", "t3", "t4"] as const;
const UNKNOWN = "t9";
const HUMAN = "human:ben";
const AGENT = "agent:codex";
const branchOf = (id: string): string => task(id, null, false).branch;

/** Every call goes through here, so a new input to `derive` changes one line. */
const run = (
  events: ReadonlyArray<Event>,
  commits: ReadonlyArray<GitCommit>,
  plan: Manifest = manifest,
): Derived => derive(plan, [], config, events, commits);

const taskOf = (derived: Derived, id: string): DerivedTask =>
  Option.getOrThrow(Array.findFirst(derived.tasks, (derivedTask) => derivedTask.id === id));

const kindsOf = (derived: Derived, id: string): ReadonlyArray<TraceWarningKind> =>
  Array.map(
    Array.filter(derived.warnings, (warning) => warning.taskId === id),
    ({ kind }) => kind,
  );

const line = (taskId: string, status: TaskStatus, second: number, actor: Actor = "orchestrator") =>
  Schema.decodeSync(Event)({
    actor,
    status,
    taskId,
    ts: DateTime.formatIso(DateTime.makeUnsafe(second * 1000)),
  });

const shaOf = (n: number): Sha => Schema.decodeSync(Sha)(String.padStart(40, "0")(`${n}`));

/** What git shows of a commit, before it has a sha. */
interface Written {
  readonly branch: string | null;
  readonly file: string;
  readonly onBase: boolean;
  readonly sections: boolean;
  readonly session: boolean;
  readonly taskId: string | null;
}

/** The commit numbered `n`, its trailers complete unless `sections` or `session` says not. */
const commitOf = (written: Written, n: number): GitCommit =>
  Schema.decodeSync(GitCommit)({
    branch: written.branch,
    files: [written.file],
    onBase: written.onBase,
    parents: n === 0 ? [] : [shaOf(n - 1)],
    sections: written.sections ? ["spec.status.derivation"] : [],
    session: written.session ? "s_abc123" : null,
    sha: shaOf(n),
    subject: `Commit ${n}`,
    taskId: written.taskId,
  });

/** A commit with all its trailers, on its task's branch, that the base branch does not reach. */
const committed = (taskId: string, n: number, file: string = PLAIN, onBase = false): GitCommit =>
  commitOf({ branch: branchOf(taskId), file, onBase, sections: true, session: true, taskId }, n);

/** The commit a squash merge leaves on the base branch, with the task's trailers. */
const squashed = (taskId: string, n: number): GitCommit =>
  commitOf({ branch: null, file: PLAIN, onBase: true, sections: true, session: true, taskId }, n);

const Commits = Schema.Array(
  Schema.Struct({
    branch: Schema.NullOr(Schema.Literals([branchOf("t1"), branchOf("t4"), "cairn-mvp/99-other"])),
    file: Schema.Literals([PLAIN, MIGRATION, INFRA]),
    onBase: Schema.Boolean,
    sections: Schema.Boolean,
    session: Schema.Boolean,
    taskId: Schema.NullOr(Schema.Literals(["t1", "t2", "t3", "t4", UNKNOWN])),
  }),
).check(Schema.isMaxLength(12));

const commitsOf = (written: ReadonlyArray<Written>): ReadonlyArray<GitCommit> =>
  Array.map(written, commitOf);

const Lines = (actor: Schema.Codec<Actor>) =>
  Schema.Array(Schema.Struct({ actor, status: TaskStatus })).check(Schema.isMaxLength(12));

/** Lines for `taskId`, one second apart in the order they were written. */
const linesFor = (
  taskId: string,
  lines: ReadonlyArray<{ readonly actor: Actor; readonly status: TaskStatus }>,
): ReadonlyArray<Event> =>
  Array.map(lines, ({ actor, status }, second) => line(taskId, status, second, actor));

const Landing = Schema.Literals(["none", "merged", "squashed"]);

/** A task's commits: one that may touch a high-trust path, landed by a merge, a squash or not at all. */
const landedAs = (
  taskId: string,
  landing: typeof Landing.Type,
  file: string,
): ReadonlyArray<GitCommit> =>
  Array.appendAll(
    [committed(taskId, 0, file, landing === "merged")],
    landing === "squashed" ? [squashed(taskId, 1)] : [],
  );

it.prop(
  "a task's gate is its plan gate plus each high-trust pattern a commit with its trailer changed",
  [Commits],
  ([written]) => {
    const derived = run([], commitsOf(written));
    const patternsOf = (id: string) =>
      Array.filter(config.humanPaths, (pattern) =>
        Array.some(
          written,
          ({ file, taskId }) =>
            taskId === id && Option.exists(Record.get(PATTERN_OF, file), (hit) => hit === pattern),
        ),
      );
    expect(Array.map(IDS, (id) => taskOf(derived, id).gate)).toStrictEqual(
      Array.map(IDS, (id) => {
        const reasons = Array.map(patternsOf(id), (pattern) => `path:${pattern}`);
        return { reasons, required: Array.isReadonlyArrayNonEmpty(reasons) };
      }),
    );
  },
);

it.prop(
  "a commit that touches a high-trust path gates the task for every report, as the plan would",
  [Lines(Schema.Literals(["orchestrator", HUMAN, AGENT])), Landing],
  ([lines, landing]) => {
    const events = linesFor("t4", lines);
    const gatedByCommit = run(events, landedAs("t4", landing, MIGRATION));
    const gatedByPlan = run(events, landedAs("t4", landing, PLAIN), manifestWith("t4"));
    expect(taskOf(gatedByCommit, "t4").status).toBe(taskOf(gatedByPlan, "t4").status);
    expect(kindsOf(gatedByCommit, "t4")).toStrictEqual(kindsOf(gatedByPlan, "t4"));
  },
);

it.prop(
  "a landing moves only a done task to landed; from anywhere else it is a warning",
  [Lines(Schema.Literals(["orchestrator", HUMAN, AGENT])), Schema.Literals(["merged", "squashed"])],
  ([lines, landing]) => {
    const events = linesFor("t4", lines);
    const before = taskOf(run(events, landedAs("t4", "none", PLAIN)), "t4").status;
    const after = run(events, landedAs("t4", landing, PLAIN));
    expect(taskOf(after, "t4").status).toBe(before === "done" ? "landed" : before);
    expect(kindsOf(after, "t4")).toStrictEqual(
      Array.appendAll(
        kindsOf(run(events, landedAs("t4", "none", PLAIN)), "t4"),
        before === "done" || before === "landed" ? [] : ["landed-without-approval"],
      ),
    );
  },
);

it.prop(
  "a task that touched a migration never lands without a human, and the tasks above it wait",
  [Lines(Schema.Literals(["orchestrator", AGENT, "agent:claude"])), Landing],
  ([lines, landing]) => {
    const derived = run(linesFor("t1", lines), landedAs("t1", landing, MIGRATION));
    const status = taskOf(derived, "t1").status;
    expect(["done", "landed"]).not.toContain(status);
    expect(Array.map(["t2", "t3"], (id) => taskOf(derived, id).waiting)).toStrictEqual([
      status === "blocked_on_human",
      status === "blocked_on_human",
    ]);
  },
);

it.prop(
  "each task's commits are the commits with its trailer, in git's order, as the trace shows them",
  [Commits],
  ([written]) => {
    const commits = commitsOf(written);
    const derived = run([], commits);
    expect(Array.map(IDS, (id) => taskOf(derived, id).commits)).toStrictEqual(
      Array.map(IDS, (id) =>
        pipe(
          Array.filter(commits, ({ taskId }) => taskId === id),
          Array.map(Struct.pick(["files", "parents", "sections", "session", "sha", "subject"])),
        ),
      ),
    );
  },
);

/** The manifest task whose branch it is, or null for any other branch. */
const ownerOf = (branch: string): string | null =>
  Option.getOrNull(Array.findFirst(IDS, (id) => branchOf(id) === branch));

/** The part of a warning the commit warnings are checked on. */
interface Flagged {
  readonly kind: TraceWarningKind;
  readonly sha: string;
  readonly taskId: string | null;
}

it.prop(
  "a commit on a task branch without its trailers, or with a trailer for an unknown task, is a warning",
  [Commits],
  ([written]) => {
    const commits = Array.map(written, (fields, n) =>
      commitOf(Struct.assign(fields, { onBase: false }), n),
    );
    const expected = Array.flatMap(commits, (commit): ReadonlyArray<Flagged> => {
      const incomplete =
        Predicate.isNull(commit.taskId) ||
        Predicate.isNull(commit.session) ||
        !Array.isReadonlyArrayNonEmpty(commit.sections);
      return Array.flatten([
        pipe(
          Option.fromNullOr(commit.branch),
          Option.filter(() => incomplete),
          Option.map((branch): Flagged => ({
            kind: "missing-trailers",
            sha: commit.sha,
            taskId: ownerOf(branch),
          })),
          Option.toArray,
        ),
        commit.taskId === UNKNOWN
          ? [{ kind: "unknown-task" as const, sha: commit.sha, taskId: commit.taskId }]
          : [],
      ]);
    });
    expect(
      Array.map(run([], commits).warnings, (warning) =>
        Struct.pick(warning, ["kind", "sha", "taskId"]),
      ),
    ).toStrictEqual(expected);
  },
);

const finished = [line("t4", "running", 1), line("t4", "done", 2)];

it("a squash merge on the base branch lands a done task", () => {
  const derived = run(finished, [committed("t4", 0), squashed("t4", 1)]);
  expect(taskOf(derived, "t4").status).toBe("landed");
  expect(derived.warnings).toStrictEqual([]);
});

it("a task whose own commits the base branch reaches lands", () => {
  expect(taskOf(run(finished, [committed("t4", 0, PLAIN, true)]), "t4").status).toBe("landed");
  expect(taskOf(run(finished, [committed("t4", 0)]), "t4").status).toBe("done");
});

it("a migration committed after done holds the task in blocked_on_human, landed or not", () => {
  const derived = run(finished, [committed("t4", 0, MIGRATION, true)]);
  expect(taskOf(derived, "t4").status).toBe("blocked_on_human");
  expect(taskOf(derived, "t4").gate).toStrictEqual({
    reasons: ["path:**/migrations/**"],
    required: true,
  });
  expect(derived.warnings).toStrictEqual([
    {
      kind: "landed-without-approval",
      message: `t4: ${String.slice(0, 7)(shaOf(0))} reached the base branch while the task was blocked_on_human; it stays blocked_on_human`,
      sha: shaOf(0),
      taskId: "t4",
    },
  ]);
  const approved = run(Array.append(finished, line("t4", "done", 3, HUMAN)), [
    committed("t4", 0, MIGRATION, true),
  ]);
  expect(taskOf(approved, "t4").status).toBe("landed");
  expect(approved.warnings).toStrictEqual([]);
});

it("a commit only on the base branch needs no trailers", () => {
  const plain = commitOf(
    { branch: null, file: PLAIN, onBase: true, sections: false, session: false, taskId: null },
    0,
  );
  expect(run([], [plain]).warnings).toStrictEqual([]);
});
