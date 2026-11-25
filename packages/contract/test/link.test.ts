import { expect, it } from "@effect/vitest";
import { Array, Match, Option, Result, Schema, String, pipe } from "effect";
import * as fc from "fast-check";

import {
  CommitStep,
  DiffStep,
  FileStep,
  LinesStep,
  LinkFromPath,
  NoteStep,
  PassageStep,
  SectionStep,
  SegmentStep,
  StackStep,
  Step,
  TaskStep,
  TurnStep,
  decodeLink,
  encodeLink,
} from "../src/index.ts";

const decode = Schema.decodeUnknownResult(LinkFromPath);
const encode = Schema.encodeResult(LinkFromPath);
const steps = Schema.decodeUnknownSync(Schema.Array(Step));

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** The parts of a well-formed link, put in order by `linkOf`. */
const Parts = Schema.Struct({
  code: Schema.Literals(["none", "commit", "diff"]),
  commit: CommitStep,
  depth: Schema.Literals([0, 1, 2]),
  diff: DiffStep,
  end: Schema.Literals(["none", "turn", "note"]),
  file: FileStep,
  lines: LinesStep,
  navigation: Schema.Array(
    Schema.Union([SectionStep, PassageStep, TaskStep, StackStep, SegmentStep]),
  ).check(Schema.isMaxLength(4)),
  note: NoteStep,
  task: TaskStep,
  turn: TurnStep,
});
type Parts = typeof Parts.Type;

/**
 * A link that follows the rules: any sections, passages, tasks, stacks and segments; then a diff
 * after a task or a commit, with a file and its lines; then a turn, or a note when nothing opened
 * code.
 */
const linkOf = (parts: Parts): ReadonlyArray<Step> => {
  const code: ReadonlyArray<Step> = Match.value(parts.code).pipe(
    Match.when("none", () => []),
    Match.when("commit", () => [parts.commit]),
    Match.when("diff", () => [parts.task, parts.diff]),
    Match.exhaustive,
  );
  const opened = Array.isReadonlyArrayNonEmpty(code)
    ? Array.appendAll(code, Array.take([parts.file, parts.lines], parts.depth))
    : [];
  const end: ReadonlyArray<Step> = Match.value(parts.end).pipe(
    Match.when("none", () => []),
    Match.when("turn", () => [parts.turn]),
    Match.when("note", () => (Array.isReadonlyArrayNonEmpty(code) ? [] : [parts.note])),
    Match.exhaustive,
  );
  return Array.flatten([parts.navigation, opened, end]);
};

/** The path a browser keeps after it parses the link as a URL. */
const throughUrl = (path: string) => new URL(path, "https://prdtrace.com").pathname;

it.prop(
  "writing a well-formed link and reading it back gives the same steps",
  [Parts],
  ([parts]) => {
    const link = linkOf(parts);
    const path = Result.getOrThrow(encode(link));
    expect(throughUrl(path)).toBe(path);
    expect(decode(path)).toEqual(Result.succeed(link));
    expect(decodeLink(path)).toEqual(Result.succeed(link));
    expect(encode(link)).toEqual(Result.succeed(path));
    expect(encodeLink(link)).toEqual(Result.succeed(path));
  },
);

/** The ordering rules of spec.contract.links, written out so that changing one fails this test. */
const followsRules = (link: ReadonlyArray<Step>) =>
  Array.every(link, (step, index) => {
    const before = Array.take(link, index);
    const previous = Option.map(Array.last(before), ({ kind }) => kind);
    const after = (...kinds: ReadonlyArray<Step["kind"]>) =>
      Array.some(before, ({ kind }) => Array.contains(kinds, kind));
    const directlyAfter = (...kinds: ReadonlyArray<Step["kind"]>) =>
      Option.exists(previous, (kind) => Array.contains(kinds, kind));
    return (
      (step.kind !== "diff" || directlyAfter("task")) &&
      (step.kind !== "file" || directlyAfter("diff", "commit")) &&
      (step.kind !== "lines" || directlyAfter("file")) &&
      (!after("diff", "commit", "turn") || Array.contains(["file", "lines", "turn"], step.kind)) &&
      !((step.kind === "diff" || step.kind === "commit") && after("diff", "commit")) &&
      !after("turn") &&
      !after("note")
    );
  });

/** A well-formed link with one more step put in at `at`, so most lists are near the rules' edge. */
const Inserted = Schema.Struct({
  at: Schema.Int.check(Schema.isBetween({ maximum: 16, minimum: 0 })),
  parts: Parts,
  step: Step,
});

it.prop(
  "a list of steps is written exactly when it follows the ordering rules",
  [Inserted, Schema.Array(Step).check(Schema.isMaxLength(5))],
  ([{ at, parts, step }, random]) => {
    const link = linkOf(parts);
    const index = at % (Array.length(link) + 1);
    const inserted = Array.appendAll(
      Array.take(link, index),
      Array.prepend(Array.drop(link, index), step),
    );
    Array.forEach([inserted, random], (list) => {
      expect(Result.isSuccess(encode(list))).toBe(followsRules(list));
      expect(Result.isSuccess(encodeLink(list))).toBe(followsRules(list));
    });
  },
  { arbitrary: { runs: 500 } },
);

const SAMPLES = [
  "/",
  "%",
  "%2F",
  "%%",
  " ",
  "😀",
  "𝄞",
  "👩‍👩‍👧",
  "a",
  "é",
  "?",
  "#",
  "+",
  "&",
  ".",
  "..",
  "\\",
];
const word = fc.string({ maxLength: 8, minLength: 1, unit: fc.constantFrom(...SAMPLES) });
const text = fc
  .array(word, { maxLength: 6, minLength: 1 })
  .map((words) => pipe(Array.join(words, " "), String.replace(/\s+/gu, " "), String.trim));
const argument = text.filter((t) => String.isNonEmpty(t) && t !== "." && t !== "..");

const refusedStep = (link: ReadonlyArray<unknown>) =>
  Result.isFailure(Schema.decodeUnknownResult(Schema.Array(Step))(link));

it("a quote, file path or turn of . or .. is refused, since a browser drops it from a URL", () => {
  expect(
    Array.map(
      [
        [{ kind: "passage", quote: "..", section: "prd.a" }],
        [{ kind: "file", path: "." }],
        [{ kind: "turn", session: "s_abcdef", turn: ".." }],
        [{ kind: "passage", quote: "...", section: "prd.a" }],
      ],
      refusedStep,
    ),
  ).toEqual([true, true, true, false]);
  expect(
    Result.match(decodeLink("/passage/prd.a/.."), {
      onFailure: (e) => e.message,
      onSuccess: () => "decoded",
    }),
  ).toBe("step 0 (passage).quote: Expected text other than . or ..");
});

it("quotes and file paths with /, %, spaces, emoji and surrogate pairs come back unchanged", () => {
  fc.assert(
    fc.property(argument, argument, (quote, path) => {
      const link = steps([
        { kind: "passage", quote, section: "prd.deep-links.targets" },
        { id: "t118", kind: "task" },
        { head: SHA, kind: "diff" },
        { kind: "file", path },
      ]);
      const written = Result.getOrThrow(encode(link));
      expect(throughUrl(written)).toBe(written);
      expect(decode(written)).toEqual(Result.succeed(link));
      // Nine separators and no more: each argument's own / is encoded.
      expect(Array.length(String.split(written, "/"))).toBe(10);
    }),
  );
});

it("the PRD's cairn link example writes the path the spec gives", () => {
  const link = steps([
    { id: "prd.code-view", kind: "section" },
    { id: "t74", kind: "task" },
    { head: SHA, kind: "diff" },
    { kind: "file", path: "packages/cli/src/api.ts" },
    { end: 40, kind: "lines", side: "new", start: 40 },
  ]);
  const path = `/section/prd.code-view/task/t74/diff/${SHA}/file/packages%2Fcli%2Fsrc%2Fapi.ts/lines/n40`;
  expect(encode(link)).toEqual(Result.succeed(path));
  expect(decode(path)).toEqual(Result.succeed(link));
});

it("a range is written n40-42 or o12, a single line never as n40-40", () => {
  const lines = (side: string, start: number, end: number) =>
    steps([
      { kind: "commit", sha: SHA },
      { kind: "file", path: "a.ts" },
      { end, kind: "lines", side, start },
    ]);
  expect(encode(lines("new", 40, 42))).toEqual(
    Result.succeed(`/commit/${SHA}/file/a.ts/lines/n40-42`),
  );
  expect(encode(lines("old", 12, 12))).toEqual(
    Result.succeed(`/commit/${SHA}/file/a.ts/lines/o12`),
  );
  expect(decode(`/commit/${SHA}/file/a.ts/lines/o12-12`)).toEqual(
    Result.succeed(lines("old", 12, 12)),
  );
});

it("the empty link is /, and a trailing / is read but never written", () => {
  expect(encode([])).toEqual(Result.succeed("/"));
  expect(decode("/")).toEqual(Result.succeed([]));
  const task = steps([{ id: "t1", kind: "task" }]);
  expect(decode("/task/t1/")).toEqual(Result.succeed(task));
  expect(encode(task)).toEqual(Result.succeed("/task/t1"));
});

it("no step is named like a server route or a built file", () => {
  expect(Array.intersection(Step.discriminants, ["api", "presence", "assets"])).toEqual([]);
});

const refusal = (path: string) =>
  Result.match(decodeLink(path), {
    onFailure: ({ field, index, message, step }) => ({ field, index, message, step }),
    onSuccess: () => "decoded",
  });

it("misplaced steps, a backwards range, a bad sha and bad percent-encoding are refused", () => {
  const cases = [
    `/file/packages%2Fcli%2Fsrc%2Fapi.ts`,
    `/task/t1/lines/n40`,
    `/commit/${SHA}/task/t1`,
    `/commit/${SHA}/file/a.ts/lines/n42-40`,
    `/task/t1/diff/0123abc`,
    `/passage/prd.deep-links/caf%E9`,
  ];
  expect(Array.map(cases, refusal)).toEqual([
    {
      field: Option.none(),
      index: 0,
      message: "step 0 (file): must follow a diff or a commit",
      step: "file",
    },
    {
      field: Option.none(),
      index: 1,
      message: "step 1 (lines): must follow a file",
      step: "lines",
    },
    {
      field: Option.none(),
      index: 1,
      message: "step 1 (task): must not come after a commit",
      step: "task",
    },
    {
      field: Option.some("end"),
      index: 2,
      message: "step 2 (lines).end: must not be less than start",
      step: "lines",
    },
    {
      field: Option.some("head"),
      index: 1,
      message: "step 1 (diff).head: expected 40 lowercase hex characters",
      step: "diff",
    },
    {
      field: Option.some("quote"),
      index: 0,
      message: "step 0 (passage).quote: bad percent-encoding",
      step: "passage",
    },
  ]);
  Array.forEach(cases, (path) => {
    expect(Result.isFailure(decode(path))).toBe(true);
  });
});

it("a refused path's schema error carries the LinkError's message", () => {
  expect(
    Result.match(decode("/file/a.ts"), { onFailure: (e) => e.message, onSuccess: () => "decoded" }),
  ).toBe("step 0 (file): must follow a diff or a commit");
});

it("a path that is not made of steps is refused", () => {
  expect(
    Array.map(["task/t1", "/tasks/t1", "/task", "/lines/40"], (path) =>
      Result.match(decodeLink(path), { onFailure: (e) => e.message, onSuccess: () => "decoded" }),
    ),
  ).toEqual([
    "step 0 (task): a link starts with /",
    "step 0 (tasks): not a step",
    "step 0 (task).id: missing",
    "step 0 (lines): expected n40, n40-42, o12 or o12-14",
  ]);
});
