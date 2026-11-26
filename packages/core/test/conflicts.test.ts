import { PrdSectionId, SpecSectionId, TaskId, defaultConfig } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema } from "effect";

import { changesOf, historyOf, indexOf, scoreOf, togetherOf } from "../src/index.ts";
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
