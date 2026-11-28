import {
  Manifest,
  ManifestTask,
  PrdSectionId,
  Slug,
  SpecSectionId,
  TaskDraft,
  TaskId,
  defaultConfig,
} from "@cairn/contract";
import type { HumanGate } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, HashSet, Option, Result, Schema, Struct } from "effect";

import {
  STACKS_CLOSE,
  STACKS_OPEN,
  changesOf,
  conflictsOf,
  gateOf,
  historyOf,
  hotspotsOf,
  indexOf,
  lint,
  orderingOf,
  orderingsOf,
  scoreOf,
  sectionsOf,
  stackOf,
  togetherOf,
  withStackDiagram,
} from "../src/index.ts";
import type { History, IndexTask } from "../src/index.ts";

const config = defaultConfig.conflicts;

const A = TaskId.make("t1");
const B = TaskId.make("t2");
const C = TaskId.make("t3");

const task = (id: TaskId, dependsOn: ReadonlyArray<TaskId>): IndexTask => ({
  dependsOn,
  id,
  orderedAfter: [],
  parent: null,
  prdSections: [PrdSectionId.make("prd.conflicts")],
  specSections: [SpecSectionId.make("spec.planning.conflict-scores")],
});

/** t1 and t2 can run together; t3 needs t1, so it cannot run with t1, and t2 needs t3, so not with t1 either. */
const index = indexOf({
  manifest: { tasks: [task(A, []), task(B, [C]), task(C, [A])] },
  prd: "",
  specIndex: { sections: [] },
});
const parallel = indexOf({
  manifest: { tasks: [task(A, []), task(B, [])] },
  prd: "",
  specIndex: { sections: [] },
});

const NONE: History = historyOf([]);

/** A plan's files: `t1` has `a` and `t2` has `b`. */
const score = (a: ReadonlyArray<string>, b: ReadonlyArray<string>, history: History = NONE) =>
  Option.getOrThrow(scoreOf(parallel, A, B, (id) => (id === A ? a : b), history, config));

const changed = (n: number, files: ReadonlyArray<string>) => Array.replicate({ files }, n);

const File = Schema.Literals([
  "src/model.ts",
  "src/update.ts",
  "src/view.ts",
  "src/index.ts",
  "pnpm-lock.yaml",
  "apps/demo-trace.json",
  "docs/readme.md",
]);
const Files = Schema.Array(File).check(Schema.isMaxLength(5));
const Commits = Schema.Array(Schema.Struct({ files: Files })).check(Schema.isMaxLength(12));

/** The score with a rounding allowance: a product taken in another order differs in the last bits. */
const EPSILON = 1e-12;

it("a commit that touches more than 20 files is left out of the history", () => {
  const mass = Array.makeBy(21, (n) => `src/f${n}.ts`);
  const history = historyOf([{ files: mass }, { files: ["src/a.ts", "src/b.ts"] }]);
  expect(changesOf(history, "src/f0.ts")).toBe(0);
  expect(togetherOf(history, "src/f0.ts", "src/f1.ts")).toBe(0);
  expect(changesOf(history, "src/a.ts")).toBe(1);
  expect(togetherOf(history, "src/b.ts", "src/a.ts")).toBe(1);
  const edge = historyOf([{ files: Array.take(mass, 20) }]);
  expect(changesOf(edge, "src/f0.ts")).toBe(1);
});

it.prop(
  "a pair changes together no more often than either file changes, whichever is named first",
  { commits: Commits },
  ({ commits }) => {
    const history = historyOf(commits);
    Array.forEach(Array.cartesian(File.literals, File.literals), ([x, y]) => {
      expect(togetherOf(history, x, y)).toBe(togetherOf(history, y, x));
      if (x !== y) {
        expect(togetherOf(history, x, y)).toBeLessThanOrEqual(changesOf(history, x));
        expect(togetherOf(history, x, y)).toBeLessThanOrEqual(changesOf(history, y));
      }
    });
  },
);

it.prop(
  "a score lies in [0, 1) and every reason has a weight",
  { a: Files, b: Files, commits: Commits },
  ({ a, b, commits }) => {
    const { reasons, score: value } = score(a, b, historyOf(commits));
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
    expect(Array.every(reasons, ({ weight }) => weight >= 0)).toBe(true);
  },
);

it.prop(
  "a score stays below 1 however many files two tasks share, each changed often",
  { shared: Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: 1 })) },
  ({ shared }) => {
    const files = Array.makeBy(shared, (n) => `src/f${n}.ts`);
    const history = historyOf(Array.flatMap(files, (file) => changed(50, [file])));
    const { reasons, score: value } = score(files, files, history);
    expect(Array.length(reasons)).toBe(shared);
    expect(value).toBeLessThan(1);
    expect(value).toBeGreaterThanOrEqual(0.95);
  },
);

it.prop(
  "a score is the same whichever task is first",
  { a: Files, b: Files, commits: Commits },
  ({ a, b, commits }) => {
    const history = historyOf(commits);
    const forward = score(a, b, history).score;
    const backward = Option.getOrThrow(
      scoreOf(parallel, B, A, (id) => (id === A ? a : b), history, config),
    ).score;
    expect(backward).toBeCloseTo(forward, 10);
  },
);

it.prop(
  "adding a shared file never lowers a score",
  { a: Files, b: Files, commits: Commits, extra: File },
  ({ a, b, commits, extra }) => {
    const history = historyOf(commits);
    const before = score(a, b, history).score;
    const after = score(Array.append(a, extra), Array.append(b, extra), history).score;
    expect(after).toBeGreaterThanOrEqual(before - EPSILON);
  },
);

it.prop(
  "a file one task changes and the other does not adds nothing",
  { a: Files, b: Files, commits: Commits },
  ({ a, b, commits }) => {
    const history = historyOf(commits);
    const alone = "docs/only-a.md";
    expect(score(Array.append(a, alone), b, history).score).toBe(score(a, b, history).score);
  },
);

it.prop(
  "two tasks that share only a generated file score 0",
  { commits: Commits },
  ({ commits }) => {
    const { reasons, score: value } = score(
      ["pnpm-lock.yaml"],
      ["pnpm-lock.yaml"],
      historyOf(commits),
    );
    expect(value).toBe(0);
    expect(reasons).toStrictEqual([{ file: "pnpm-lock.yaml", kind: "generated", weight: 0 }]);
  },
);

it.prop(
  "a pair where one task needs the other, directly or through others, is never scored",
  { a: Files, b: Files, commits: Commits },
  ({ a, b, commits }) => {
    const history = historyOf(commits);
    const files = (id: TaskId) => (id === A ? a : b);
    expect(scoreOf(index, A, B, files, history, config)).toStrictEqual(Option.none());
    expect(scoreOf(index, B, A, files, history, config)).toStrictEqual(Option.none());
    expect(scoreOf(index, A, C, files, history, config)).toStrictEqual(Option.none());
  },
);

it("two tasks planned against one source file score higher than two that share a lockfile, and say why", () => {
  const source = score(["src/model.ts", "pnpm-lock.yaml"], ["src/model.ts", "pnpm-lock.yaml"]);
  const lockfile = score(["src/view.ts", "pnpm-lock.yaml"], ["src/update.ts", "pnpm-lock.yaml"]);
  expect(source.score).toBeGreaterThan(lockfile.score);
  expect(source.score).toBeGreaterThanOrEqual(config.high);
  expect(lockfile.score).toBe(0);
  expect(source.reasons).toStrictEqual([
    { file: "src/model.ts", kind: "shared", weight: 0.5 },
    { file: "pnpm-lock.yaml", kind: "generated", weight: 0 },
  ]);
});

it("a file that changes often weighs up to twice as much", () => {
  const weightAfter = (changes: number) =>
    score(["src/model.ts"], ["src/model.ts"], historyOf(changed(changes, ["src/model.ts"])))
      .reasons;
  expect(score(["src/model.ts"], ["src/model.ts"]).reasons).toStrictEqual([
    { file: "src/model.ts", kind: "shared", weight: 0.5 },
  ]);
  expect(weightAfter(25)).toStrictEqual([{ file: "src/model.ts", kind: "shared", weight: 0.75 }]);
  expect(weightAfter(50)).toStrictEqual([{ file: "src/model.ts", kind: "shared", weight: 1 }]);
  expect(weightAfter(500)).toStrictEqual([{ file: "src/model.ts", kind: "shared", weight: 1 }]);
  const often = score(
    ["src/model.ts"],
    ["src/model.ts"],
    historyOf(changed(500, ["src/model.ts"])),
  );
  expect(often.score).toBeCloseTo(0.95, 10);
});

it("a file both tasks only add lines to scores low", () => {
  const { reasons, score: value } = score(["src/index.ts"], ["src/index.ts"]);
  expect(reasons).toStrictEqual([{ file: "src/index.ts", kind: "additive", weight: 0.1 }]);
  expect(value).toBeCloseTo(0.1, 10);
  expect(value).toBeLessThan(config.high);
});

it("a declared directory is shared with a file inside it, and the reason names the file", () => {
  const { reasons } = score(["src/"], ["src/model.ts", "docs/readme.md"]);
  expect(reasons).toStrictEqual([{ file: "src/model.ts", kind: "shared", weight: 0.5 }]);
  expect(score(["src/"], ["srcs/model.ts"]).reasons).toStrictEqual([]);
  expect(score(["src/"], ["src/ui/"]).reasons).toStrictEqual([
    { file: "src/ui/", kind: "shared", weight: 0.5 },
  ]);
});

it("files that change together count as shared, so model.ts and update.ts still score", () => {
  const together = historyOf(
    Array.appendAll(changed(3, ["src/model.ts", "src/update.ts"]), changed(2, ["src/view.ts"])),
  );
  const { reasons, score: value } = score(["src/model.ts"], ["src/update.ts"], together);
  expect(reasons).toStrictEqual([
    { file: "src/model.ts", kind: "coupled", other: "src/update.ts", weight: 0.25 * (1 + 3 / 50) },
  ]);
  expect(value).toBeGreaterThan(0);
  expect(value).toBeLessThan(config.high);
});

it("files coupled in fewer than 3 commits, or in under half of the rarer file's commits, are not", () => {
  const twice = historyOf(changed(2, ["src/model.ts", "src/update.ts"]));
  expect(score(["src/model.ts"], ["src/update.ts"], twice).reasons).toStrictEqual([]);
  const rarely = historyOf(
    Array.appendAll(changed(3, ["src/model.ts", "src/update.ts"]), changed(4, ["src/update.ts"])),
  );
  // update.ts changed 7 times and model.ts 3: the rarer file always came with it, so it is coupled.
  expect(score(["src/model.ts"], ["src/update.ts"], rarely).reasons).toHaveLength(1);
  const apart = historyOf(
    Array.flatten([
      changed(3, ["src/model.ts", "src/update.ts"]),
      changed(4, ["src/update.ts"]),
      changed(4, ["src/model.ts"]),
    ]),
  );
  // each changed 7 times and together only 3: under half.
  expect(score(["src/model.ts"], ["src/update.ts"], apart).reasons).toStrictEqual([]);
});

it("a generated or additive file is never coupled", () => {
  const history = historyOf(changed(5, ["src/model.ts", "pnpm-lock.yaml", "src/index.ts"]));
  expect(score(["src/model.ts"], ["pnpm-lock.yaml"], history).reasons).toStrictEqual([]);
  expect(score(["src/model.ts"], ["src/index.ts"], history).reasons).toStrictEqual([]);
});

const feature = Schema.decodeSync(Slug)("cairn-mvp");
const decodeDraft = Schema.decodeUnknownSync(TaskDraft);
const PLAN_PRD = "# Product {#prd.product}\n\n## Goal {#prd.goal}\n";
const PLAN_SPEC = "# Spec {#spec.spec}\n\n- Implements: `prd.goal`\n\n## Store {#spec.store}\n";
const planSections = Array.appendAll(sectionsOf(PLAN_PRD), sectionsOf(PLAN_SPEC));
const gateConfig = { humanPaths: ["**/migrations/**"] };
const gates = (draft: TaskDraft): HumanGate => gateOf(draft, planSections, gateConfig, []);

/**
 * Drafts as a planner might return them: draft `i` depends on the drafts in `needs` below it and
 * changes one or two files, which may be a migration (so it is gated) or a lockfile.
 */
const PlanDrafts = Schema.Array(
  Schema.Struct({
    files: Schema.Array(
      Schema.Literals([
        "src/model.ts",
        "src/update.ts",
        "src/view.ts",
        "db/migrations/001.sql",
        "pnpm-lock.yaml",
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
    needs: Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 7, minimum: 0 }))).check(
      Schema.isMaxLength(2),
    ),
  }),
).check(Schema.isMaxLength(8));
type PlanDrafts = typeof PlanDrafts.Type;

const draftsOf = (drafts: PlanDrafts, prefix: string): ReadonlyArray<TaskDraft> =>
  Array.map(drafts, (draft, position) =>
    decodeDraft({
      category: "feature",
      dependsOn: Array.map(
        Array.dedupe(Array.filter(draft.needs, (need) => need < position)),
        (need) => `${prefix} ${need}`,
      ),
      files: Array.dedupe(draft.files),
      model: "sonnet",
      prdSections: ["prd.goal"],
      reasoning: "high",
      specSections: ["spec.store"],
      title: `${prefix} ${position}`,
    }),
  );

/** A plan that has `old` already and adds `added`: the stack before and after the orderings. */
const planned = (old: PlanDrafts, added: PlanDrafts, history: History = NONE) => {
  const existing = Result.getOrThrow(stackOf(feature, draftsOf(old, "Old"), gates));
  const drafts = draftsOf(added, "New");
  const unordered = Result.getOrThrow(stackOf(feature, drafts, gates, existing));
  const fresh = Array.drop(unordered, Array.length(existing));
  const orderings = orderingsOf(
    fresh,
    existing,
    conflictsOf(existing, fresh, history, config),
    config,
  );
  const ordered = Result.getOrThrow(
    stackOf(feature, drafts, gates, existing, Array.map(orderings.applied, orderingOf)),
  );
  return { existing, orderings, ordered, unordered };
};

const byId = (tasks: ReadonlyArray<ManifestTask>, id: TaskId) =>
  Option.getOrThrow(Array.findFirst(tasks, (candidate) => candidate.id === id));

const Plans = Schema.Struct({ added: PlanDrafts.check(Schema.isMinLength(1)), old: PlanDrafts });

it.prop("an applied ordering never involves a gated task", [Plans], ([{ added, old }]) => {
  const { orderings, ordered } = planned(old, added);
  expect(
    Array.every(
      orderings.applied,
      ({ earlier, later }) =>
        !byId(ordered, earlier).humanGate.required && !byId(ordered, later).humanGate.required,
    ),
  ).toBe(true);
});

it.prop(
  "orderings keep every task's ID and dependsOn, change no existing task, and give each stacked task a parent",
  [Plans],
  ([{ added, old }]) => {
    const { existing, orderings, ordered, unordered } = planned(old, added);
    expect(Array.map(ordered, ({ dependsOn, id }) => [id, dependsOn])).toEqual(
      Array.map(unordered, ({ dependsOn, id }) => [id, dependsOn]),
    );
    expect(Array.take(ordered, Array.length(existing))).toEqual(existing);
    expect(
      Array.map(orderings.applied, ({ later }) => {
        const after = byId(ordered, later);
        return [after.orderedAfter[0]?.task, after.parent !== null];
      }),
    ).toEqual(Array.map(orderings.applied, ({ earlier }) => [earlier, true]));
    // A task is stacked on one other task at most, and only a new task is.
    const stacked = Array.map(orderings.applied, ({ later }) => later);
    expect(Array.dedupe(stacked)).toEqual(stacked);
    expect(
      Array.every(existing, ({ orderedAfter }) => Array.isReadonlyArrayEmpty(orderedAfter)),
    ).toBe(true);
  },
);

it.prop("a plan with its orderings applied passes lint", [Plans], ([{ added, old }]) => {
  const { ordered } = planned(old, added);
  const manifest = Schema.decodeUnknownSync(Manifest)({
    baseBranch: "main",
    feature,
    tasks: Schema.encodeSync(Schema.Array(ManifestTask))(ordered),
    version: 1,
  });
  const spec = withStackDiagram(`${PLAN_SPEC}\n${STACKS_OPEN}\n${STACKS_CLOSE}\n`, manifest);
  // The PRD has no statements, so every task also gets a `task-without-statement` warning.
  expect(
    Array.filter(
      lint(PLAN_PRD, spec, Option.some(manifest), gateConfig),
      ({ rule }) => rule !== "task-without-statement",
    ),
  ).toEqual([]);
});

it.prop(
  "every high pair is either applied or recommended, highest score first",
  [Plans],
  ([{ added, old }]) => {
    const { existing, orderings, unordered } = planned(old, added);
    const fresh = Array.drop(unordered, Array.length(existing));
    const high = Array.filter(
      conflictsOf(existing, fresh, NONE, config),
      (pair) => pair.score.score >= config.high,
    );
    expect(Array.length(orderings.applied) + Array.length(orderings.recommended)).toBe(
      Array.length(high),
    );
    // A pair with an existing task is never applied.
    const oldIds = HashSet.fromIterable(Array.map(existing, ({ id }) => id));
    expect(Array.some(orderings.applied, ({ earlier }) => HashSet.has(oldIds, earlier))).toBe(
      false,
    );
  },
);

const one = (files: PlanDrafts[number]["files"], needs: ReadonlyArray<number> = []) => ({
  files,
  needs,
});

it("two new tasks planned against one source file are stacked, and the reason names the file", () => {
  const history = historyOf(changed(34, ["src/model.ts"]));
  const { orderings, ordered } = planned(
    [],
    [one(["src/model.ts"]), one(["src/model.ts"])],
    history,
  );
  expect(orderings.recommended).toEqual([]);
  expect(Array.map(orderings.applied, Struct.pick(["earlier", "later", "reason"]))).toEqual([
    { earlier: "t1", later: "t2", reason: "shares src/model.ts (34 changes)" },
  ]);
  expect(
    Struct.pick(byId(ordered, TaskId.make("t2")), ["dependsOn", "orderedAfter", "parent"]),
  ).toEqual({
    dependsOn: [],
    orderedAfter: [{ reason: "shares src/model.ts (34 changes)", task: "t1" }],
    parent: "t1",
  });
});

it("a pair that shares only a lockfile is not listed at all", () => {
  const { orderings } = planned([], [one(["pnpm-lock.yaml"]), one(["pnpm-lock.yaml"])]);
  expect(orderings).toEqual({ applied: [], recommended: [] });
});

it("a pair with a gated task, an existing task, or a task already stacked is recommended", () => {
  const gated = planned(
    [],
    [one(["db/migrations/001.sql", "src/model.ts"]), one(["src/model.ts"])],
  );
  expect(gated.orderings.applied).toEqual([]);
  expect(Array.map(gated.orderings.recommended, Struct.pick(["earlier", "later"]))).toEqual([
    { earlier: "t1", later: "t2" },
  ]);
  const existing = planned([one(["src/model.ts"])], [one(["src/model.ts"])]);
  expect(existing.orderings.applied).toEqual([]);
  expect(Array.map(existing.orderings.recommended, Struct.pick(["earlier", "later"]))).toEqual([
    { earlier: "t1", later: "t2" },
  ]);
  const three = planned([], [one(["src/model.ts"]), one(["src/model.ts"]), one(["src/model.ts"])]);
  expect(Array.map(three.orderings.applied, Struct.pick(["earlier", "later"]))).toEqual([
    { earlier: "t1", later: "t2" },
    { earlier: "t1", later: "t3" },
  ]);
  expect(Array.map(three.orderings.recommended, Struct.pick(["earlier", "later"]))).toEqual([
    { earlier: "t2", later: "t3" },
  ]);
});

it("a later task whose dependencies lie on other stacks is recommended, not stacked", () => {
  // t1 and t2 are separate stacks; t3 needs both, so it starts from the base branch, and
  // stacking it on t4's earlier neighbour would give it no parent.
  const { orderings, ordered } = planned(
    [],
    [
      one(["src/view.ts"]),
      one(["src/update.ts"]),
      one(["src/model.ts"]),
      one(["src/model.ts"], [0, 1]),
    ],
  );
  expect(byId(ordered, TaskId.make("t4")).parent).toBe(null);
  expect(orderings.applied).toEqual([]);
  expect(Array.map(orderings.recommended, Struct.pick(["earlier", "later"]))).toEqual([
    { earlier: "t3", later: "t4" },
  ]);
});

it("hotspotsOf names a source file that enough tasks able to run together share", () => {
  const { existing, unordered } = planned(
    [],
    [
      one(["src/model.ts", "pnpm-lock.yaml"]),
      one(["src/model.ts", "pnpm-lock.yaml"]),
      one(["src/model.ts", "pnpm-lock.yaml"]),
      one(["src/model.ts"], [0]),
      one(["src/view.ts"]),
    ],
  );
  const fresh = Array.drop(unordered, Array.length(existing));
  // t4 needs t1, so it cannot run with it; the lockfile is generated and never a hotspot.
  expect(hotspotsOf(existing, fresh, config)).toEqual([
    { path: "src/model.ts", tasks: ["t1", "t2", "t3"] },
  ]);
  expect(hotspotsOf(existing, fresh, { ...config, hotspot: 4 })).toEqual([]);
});

/** Every task `id` needs, directly or through the tasks it needs. */
const needsOf = (tasks: ReadonlyArray<ManifestTask>, id: TaskId): ReadonlyArray<TaskId> =>
  Array.flatMap(byId(tasks, id).dependsOn, (need) => Array.prepend(needsOf(tasks, need), need));

/** The tasks below `id` through parent links, nearest first. */
const belowOf = (tasks: ReadonlyArray<ManifestTask>, id: TaskId): ReadonlyArray<TaskId> =>
  Option.match(Option.fromNullOr(byId(tasks, id).parent), {
    onNone: () => [],
    onSome: (parent) => Array.prepend(belowOf(tasks, parent), parent),
  });

it.prop(
  "orderings never put a task below a gated task that it does not need",
  [Plans],
  ([{ added, old }]) => {
    const { existing, ordered } = planned(old, added);
    const fresh = Array.drop(ordered, Array.length(existing));
    expect(
      Array.flatMap(
        Array.filter(fresh, ({ humanGate }) => humanGate.required),
        (gate: ManifestTask) =>
          Array.filter(
            belowOf(ordered, gate.id),
            (below) => !Array.contains(needsOf(ordered, gate.id), below),
          ),
      ),
    ).toEqual([]);
  },
);

it("a pair whose stacking would slide an unneeded task below a gate is recommended", () => {
  // t3 is gated and needs only t2. Stacking t2 on t1 would put t1 below t3, which it does not need.
  const { orderings, ordered } = planned(
    [],
    [one(["src/model.ts"]), one(["src/model.ts"]), one(["db/migrations/001.sql"], [1])],
  );
  expect(byId(ordered, TaskId.make("t3")).humanGate.required).toBe(true);
  expect(orderings.applied).toEqual([]);
  expect(Array.map(orderings.recommended, Struct.pick(["earlier", "later"]))).toEqual([
    { earlier: "t1", later: "t2" },
  ]);
  expect(belowOf(ordered, TaskId.make("t3"))).toEqual(["t2"]);
});

it("a trunk task does not hide the siblings that need it from hotspotsOf", () => {
  const { existing, unordered } = planned(
    [],
    [
      one(["src/model.ts"]),
      one(["src/model.ts"], [0]),
      one(["src/model.ts"], [0]),
      one(["src/model.ts"], [0]),
    ],
  );
  const fresh = Array.drop(unordered, Array.length(existing));
  expect(hotspotsOf(existing, fresh, config)).toEqual([
    { path: "src/model.ts", tasks: ["t2", "t3", "t4"] },
  ]);
});

it("a gated task does not stack on a chain an earlier plan's ordering made", () => {
  // The first plan stacked t2 on t1, which t2 does not need.
  const history = historyOf(changed(34, ["src/model.ts"]));
  const { ordered: existing } = planned(
    [],
    [one(["src/model.ts"]), one(["src/model.ts"])],
    history,
  );
  expect(byId(existing, TaskId.make("t2")).parent).toBe("t1");
  // The next plan adds gated t3, which needs only t2, and t4 and t5, which share a file.
  const gated = decodeDraft({
    category: "feature",
    dependsOn: ["t2"],
    files: ["db/migrations/001.sql"],
    model: "sonnet",
    prdSections: ["prd.goal"],
    reasoning: "high",
    specSections: ["spec.store"],
    title: "Migrate",
  });
  const drafts = Array.prepend(
    draftsOf([one(["src/view.ts"]), one(["src/view.ts"])], "New"),
    gated,
  );
  const unordered = Result.getOrThrow(stackOf(feature, drafts, gates, existing));
  const fresh = Array.drop(unordered, Array.length(existing));
  const orderings = orderingsOf(
    fresh,
    existing,
    conflictsOf(existing, fresh, history, config),
    config,
  );
  const ordered = Result.getOrThrow(
    stackOf(feature, drafts, gates, existing, Array.map(orderings.applied, orderingOf)),
  );
  const t3 = byId(ordered, TaskId.make("t3"));
  expect(t3.humanGate.required).toBe(true);
  expect(t3.parent).toBeNull();
  // A gate already off its stack holds up no other pair.
  expect(Array.map(orderings.applied, Struct.pick(["earlier", "later"]))).toEqual([
    { earlier: "t4", later: "t5" },
  ]);
  const manifest = Schema.decodeUnknownSync(Manifest)({
    baseBranch: "main",
    feature,
    tasks: Schema.encodeSync(Schema.Array(ManifestTask))(ordered),
    version: 1,
  });
  const spec = withStackDiagram(`${PLAN_SPEC}\n${STACKS_OPEN}\n${STACKS_CLOSE}\n`, manifest);
  expect(
    Array.filter(
      lint(PLAN_PRD, spec, Option.some(manifest), gateConfig),
      ({ rule }) => rule !== "task-without-statement",
    ),
  ).toEqual([]);
});

it("hotspotsOf takes one task from each of many chains that share a file, without trying every subset", () => {
  // Thirty chains of two: each second task needs the first. Any one task of each chain can run with the rest.
  const chains = Array.flatMap(Array.range(0, 29), (chain) => [
    one(["src/model.ts"]),
    one(["src/model.ts"], [2 * chain]),
  ]);
  const existing = Result.getOrThrow(stackOf(feature, [], gates));
  const fresh = Result.getOrThrow(stackOf(feature, draftsOf(chains, "New"), gates, existing));
  const [hotspot] = hotspotsOf(existing, fresh, config);
  expect(hotspot?.path).toBe("src/model.ts");
  expect(Array.length(hotspot?.tasks ?? [])).toBe(30);
});

it("a pair whose stacking would hold a task behind a gate it does not need is recommended", () => {
  // t1 is gated and t2 needs it. Stacking t3, which needs neither, on t2 would make t3 wait on t1.
  const { orderings, ordered } = planned(
    [],
    [one(["db/migrations/001.sql"]), one(["src/model.ts"], [0]), one(["src/model.ts"])],
    historyOf(changed(34, ["src/model.ts"])),
  );
  expect(byId(ordered, TaskId.make("t1")).humanGate.required).toBe(true);
  expect(orderings.applied).toEqual([]);
  expect(Array.map(orderings.recommended, Struct.pick(["earlier", "later"]))).toEqual([
    { earlier: "t2", later: "t3" },
  ]);
  expect(byId(ordered, TaskId.make("t3")).parent).toBeNull();
});

it.prop(
  "orderings never put a new task above a gated task that it does not need",
  [Plans],
  ([{ added, old }]) => {
    const { existing, ordered } = planned(old, added);
    const gated = HashSet.fromIterable(
      Array.filterMap(ordered, ({ humanGate, id }) =>
        humanGate.required ? Result.succeed(id) : Result.failVoid,
      ),
    );
    expect(
      Array.flatMap(Array.drop(ordered, Array.length(existing)), (placed: ManifestTask) =>
        Array.filter(
          belowOf(ordered, placed.id),
          (below) =>
            HashSet.has(gated, below) && !Array.contains(needsOf(ordered, placed.id), below),
        ),
      ),
    ).toEqual([]);
  },
);

it("a gated task reads what it needs from the whole manifest, whatever order it lists tasks in", () => {
  // t3 needs t2, which needs t1, but the manifest lists them last first.
  const chain = Result.getOrThrow(
    stackOf(
      feature,
      draftsOf(
        [one(["src/model.ts"]), one(["src/model.ts"], [0]), one(["src/model.ts"], [1])],
        "Old",
      ),
      gates,
    ),
  );
  const existing = Array.reverse(chain);
  const gated = decodeDraft({
    category: "feature",
    dependsOn: ["t3"],
    files: ["db/migrations/001.sql"],
    model: "sonnet",
    prdSections: ["prd.goal"],
    reasoning: "high",
    specSections: ["spec.store"],
    title: "Migrate",
  });
  const ordered = Result.getOrThrow(stackOf(feature, [gated], gates, existing));
  expect(byId(ordered, TaskId.make("t4")).parent).toBe("t3");
  const manifest = Schema.decodeUnknownSync(Manifest)({
    baseBranch: "main",
    feature,
    tasks: Schema.encodeSync(Schema.Array(ManifestTask))(ordered),
    version: 1,
  });
  expect(
    Array.filter(
      lint(PLAN_PRD, PLAN_SPEC, Option.some(manifest), gateConfig),
      ({ rule }) => rule === "parent-mismatch",
    ),
  ).toEqual([]);
});

it("a task that declares a directory counts toward each hotspot file inside it", () => {
  const { existing, unordered } = planned(
    [],
    [one(["src/model.ts"]), one(["src/model.ts"]), one(["src/update.ts"])],
  );
  const fresh = Array.map(Array.drop(unordered, Array.length(existing)), (placed) =>
    placed.id === "t3" ? Struct.evolve(placed, { files: () => ["src/"] }) : placed,
  );
  expect(hotspotsOf(existing, fresh, config)).toEqual([
    { path: "src/model.ts", tasks: ["t1", "t2", "t3"] },
  ]);
});

it("stackOf places a task after a long existing chain where each task needs every one before it", () => {
  // A plain chain, then each task given every one before it, as a hand-edited manifest might.
  const chain = Array.map(Array.range(0, 199), (at) =>
    one(["src/model.ts"], at === 0 ? [] : [at - 1]),
  );
  const existing = Array.map(
    Result.getOrThrow(stackOf(feature, draftsOf(chain, "Old"), gates)),
    (placed, at) =>
      Struct.evolve(placed, {
        dependsOn: () =>
          Array.map(
            Array.filter(Array.range(1, at + 1), (n) => n <= at),
            (n) => TaskId.make(`t${n}`),
          ),
      }),
  );
  const gated = decodeDraft({
    category: "feature",
    dependsOn: ["t200"],
    files: ["db/migrations/001.sql"],
    model: "sonnet",
    prdSections: ["prd.goal"],
    reasoning: "high",
    specSections: ["spec.store"],
    title: "Migrate",
  });
  const ordered = Result.getOrThrow(stackOf(feature, [gated], gates, existing));
  expect(byId(ordered, TaskId.make("t201")).parent).toBe("t200");
});

/** The `bad-ordering` and `bad-parent` findings lint gives `tasks`. */
const findingsOf = (tasks: ReadonlyArray<ManifestTask>) =>
  Array.map(
    Array.filter(
      lint(
        PLAN_PRD,
        PLAN_SPEC,
        Option.some(
          Schema.decodeUnknownSync(Manifest)({
            baseBranch: "main",
            feature,
            tasks: Schema.encodeSync(Schema.Array(ManifestTask))(tasks),
            version: 1,
          }),
        ),
        gateConfig,
      ),
      ({ rule }) => rule === "bad-ordering" || rule === "bad-parent",
    ),
    Struct.pick(["message", "rule"]),
  );

it("lint finds an ordering of a task after itself, and parents that form a cycle", () => {
  const { ordered } = planned(
    [],
    [one(["src/model.ts"]), one(["src/model.ts"])],
    historyOf(changed(34, ["src/model.ts"])),
  );
  const onItself = Array.map(ordered, (candidate) =>
    candidate.id === "t1"
      ? Struct.evolve(candidate, {
          orderedAfter: () => [{ reason: "loop", task: TaskId.make("t1") }],
          parent: () => TaskId.make("t1"),
        })
      : candidate,
  );
  expect(findingsOf(onItself)).toContainEqual({
    message: "t1 is ordered after itself.",
    rule: "bad-ordering",
  });
  expect(Array.some(findingsOf(onItself), ({ rule }) => rule === "bad-parent")).toBe(true);
  const eachOther = Array.map(ordered, (candidate) =>
    candidate.id === "t1"
      ? Struct.evolve(candidate, {
          orderedAfter: () => [{ reason: "loop", task: TaskId.make("t2") }],
          parent: () => TaskId.make("t2"),
        })
      : candidate,
  );
  expect(Array.some(findingsOf(eachOther), ({ rule }) => rule === "bad-parent")).toBe(true);
});
