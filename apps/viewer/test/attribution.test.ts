import { Session } from "@cairn/contract";
import { parseDiffFromFile, type FileDiffMetadata, type Hunk } from "@pierre/diffs";
import { expect, it } from "@effect/vitest";
import { Array, Number, Option, Order, Record, Result, Schema, String } from "effect";

import { attributionOf, markLineOf, type Traced } from "../src/attribution.ts";
import { annotationsOf, parsePatch } from "../src/diff.ts";
import commitPatch from "./fixtures/attribution.patch?raw";
import commitSession from "./fixtures/attribution-session.json?raw";

const PATH = "src/a.ts";
const AT = "2026-11-25T10:00:00.000Z";

const prompt = { at: AT, id: "p", kind: "prompt", text: "Change the file." };

const toolTurn = (
  id: string,
  edits: ReadonlyArray<{
    readonly path: string;
    readonly added: ReadonlyArray<string>;
    readonly removed: ReadonlyArray<string>;
  }>,
  name = "Edit",
) => ({
  at: AT,
  edits,
  failed: false,
  id,
  input: "",
  kind: "tool",
  name,
  output: "",
  target: PATH,
});

const sessionOf = (turns: ReadonlyArray<unknown>): Session =>
  Schema.decodeUnknownSync(Session)({
    format: "claude-code",
    id: "s_attribution",
    notes: [],
    redactions: {},
    skipped: 0,
    taskId: "t1",
    turns,
    version: 1,
  });

const contentsOf = (lines: ReadonlyArray<string>): string =>
  Array.isReadonlyArrayEmpty(lines) ? "" : `${Array.join(lines, "\n")}\n`;

const diffOf = (before: ReadonlyArray<string>, after: ReadonlyArray<string>): FileDiffMetadata =>
  parseDiffFromFile(
    { contents: contentsOf(before), name: PATH },
    { contents: contentsOf(after), name: PATH },
  );

// THE PROPERTY

/** A small alphabet, so edits write the same text more than once, with two blank lines in it. */
const Line = Schema.Literals(["a", "b", "c", "d", "", "  "]);
const Place = Schema.Int.check(Schema.isBetween({ maximum: 30, minimum: 0 }));

/** One edit: at a place, remove up to three lines and write up to four. */
const Step = Schema.Struct({
  at: Place,
  insert: Schema.Array(Line).check(Schema.isMaxLength(4)),
  remove: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
});

const Case = Schema.Struct({
  original: Schema.Array(Line).check(Schema.isMaxLength(12)),
  steps: Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  /** Where lines the session did not write go in after its edits, as a formatter or a script would. */
  outside: Schema.Array(Place).check(Schema.isMaxLength(3)),
});
type Case = typeof Case.Type;

interface Applied {
  readonly lines: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
}

const insertAt = (
  lines: ReadonlyArray<string>,
  at: number,
  remove: number,
  insert: ReadonlyArray<string>,
): Applied => {
  const place = Number.remainder(at, Array.length(lines) + 1);
  const removed = Array.take(Array.drop(lines, place), remove);
  return {
    added: insert,
    lines: Array.flatten([
      Array.take(lines, place),
      insert,
      Array.drop(lines, place + Array.length(removed)),
    ]),
    removed,
  };
};

const outsideTextOf = (index: number): string => `outside ${index}`;

/** The file after the session's edits and then the outside lines, and what each edit did. */
const play = ({ original, outside, steps }: Case) => {
  const start: ReadonlyArray<string> = original;
  const [edited, applied] = Array.mapAccum(
    steps,
    start,
    (lines, { at, insert, remove }): readonly [ReadonlyArray<string>, Applied] => {
      const step = insertAt(lines, at, remove, insert);
      return [step.lines, step];
    },
  );
  const final = Array.reduce(
    outside,
    edited,
    (lines, at, index) => insertAt(lines, at, 0, [outsideTextOf(index)]).lines,
  );
  return { applied, final };
};

const isBlank = (text: string): boolean => String.isEmpty(String.trim(text));

it.prop(
  "every changed line goes to the last edit that wrote it, and lines written outside the session to none",
  [Case],
  ([generated]) => {
    const { applied, final } = play(generated);
    const file = diffOf(generated.original, final);
    // The prompt is turn 1, so edit i is turn i + 2. Each turn also writes the outside text to
    // another file, which must not trace this one's lines.
    const session = sessionOf(
      Array.prepend(
        Array.map(applied, ({ added, removed }, index) =>
          toolTurn(`e${index}`, [
            { added, path: PATH, removed },
            {
              added: Array.map(generated.outside, (_, at) => outsideTextOf(at)),
              path: "src/other.ts",
              removed: [],
            },
          ]),
        ),
        prompt,
      ),
    );
    // The oracle reads the edits, not the session: the last edit whose lines hold the text.
    const lastEditOf = (text: string, side: "added" | "removed"): Option.Option<number> =>
      Option.map(
        Array.findLastIndex(applied, (step) => Array.contains(step[side], text)),
        (index) => index + 2,
      );
    const changed = (hunkIndex: number, side: "added" | "removed"): ReadonlyArray<string> =>
      Option.match(Array.get(file.hunks, hunkIndex), {
        onNone: () => [],
        onSome: (hunk) =>
          Array.flatMap(hunk.hunkContent, (content: Hunk["hunkContent"][number]) =>
            content.type === "change"
              ? side === "added"
                ? Array.take(
                    Array.drop(file.additionLines, content.additionLineIndex),
                    content.additions,
                  )
                : Array.take(
                    Array.drop(file.deletionLines, content.deletionLineIndex),
                    content.deletions,
                  )
              : [],
          ),
      });
    const attribution = attributionOf([file], session);
    expect(Array.length(attribution.hunks)).toBe(Array.length(file.hunks));
    Array.forEach(attribution.hunks, (hunk) => {
      const lines = Array.flatMap(["removed", "added"] as const, (side) =>
        Array.map(
          Array.filter(
            Array.map(changed(hunk.index, side), (line) => String.replace(/\n$/u, "")(line)),
            (text) => !isBlank(text),
          ),
          (text) => ({ text, turn: lastEditOf(text, side) }),
        ),
      );
      const expected = Array.sort(
        Array.dedupe(Array.getSomes(Array.map(lines, ({ turn }) => turn))),
        Order.Number,
      );
      const traced: Traced = Array.isReadonlyArrayEmpty(expected)
        ? "untraced"
        : Array.every(lines, ({ turn }) => Option.isSome(turn))
          ? "traced"
          : "partly";
      expect(Array.map(hunk.turns, (turn) => turn.number)).toEqual(expected);
      expect(hunk.traced).toBe(traced);
      expect(Array.every(hunk.turns, (turn) => turn.name === "Edit")).toBe(true);
      // A line written outside the session is never traced, so its hunk is never wholly traced.
      expect(
        Array.some(lines, ({ text }) => String.startsWith("outside ")(text)) &&
          hunk.traced === "traced",
      ).toBe(false);
    });
    // The other side: each turn lists exactly the hunks that name it.
    Array.forEach(applied, (_, index) => {
      const id = `e${index}`;
      expect(
        Array.map(
          Option.getOrElse(Record.get(attribution.turns, id), () => []),
          ({ index: at }) => at,
        ),
      ).toEqual(
        Array.map(
          Array.filter(attribution.hunks, (hunk) =>
            Array.some(hunk.turns, (turn) => turn.id === id),
          ),
          ({ index: at }) => at,
        ),
      );
    });
  },
);

// EXAMPLES

it("a real commit of this repository is traced hunk by hunk to the session that wrote it", () => {
  // `git show 55a91a2`, and the tool turns of the Claude Code session that made it, read by
  // `sessionOf` from core with its prompts, replies and tool output left out.
  const { files } = Result.getOrThrow(parsePatch(commitPatch));
  const session = Schema.decodeUnknownSync(Schema.fromJsonString(Session))(commitSession);
  const attribution = attributionOf(files, session);
  expect(Array.length(attribution.hunks)).toBe(6);
  expect(Array.map(attribution.hunks, ({ traced }) => traced)).toEqual(
    Array.replicate("traced", 6),
  );
  expect(Array.every(attribution.hunks, (hunk) => Array.isReadonlyArrayNonEmpty(hunk.turns))).toBe(
    true,
  );
});

it("a line written twice goes to the later turn, and a line a formatter rewrote to none", () => {
  const file = diffOf(["keep"], ["keep", "first", "  second;", "third"]);
  const session = sessionOf([
    prompt,
    toolTurn("t1", [{ added: ["first", "third"], path: PATH, removed: [] }]),
    toolTurn("t2", [{ added: ["third", "second"], path: PATH, removed: [] }], "Write"),
  ]);
  const [hunk] = attributionOf([file], session).hunks;
  expect(
    Option.map(Option.fromUndefinedOr(hunk), ({ traced, turns }) => ({ traced, turns })),
  ).toEqual(
    Option.some({
      traced: "partly",
      turns: [
        { id: "t1", name: "Edit", number: 2 },
        { id: "t2", name: "Write", number: 3 },
      ],
    }),
  );
});

it("an edit to another path, or a prompt, traces nothing", () => {
  const file = diffOf([], ["a"]);
  const session = sessionOf([
    prompt,
    toolTurn("t1", [{ added: ["a"], path: "src/b.ts", removed: [] }]),
  ]);
  expect(attributionOf([file], session)).toEqual({
    hunks: [{ index: 0, path: PATH, traced: "untraced", turns: [] }],
    turns: {},
  });
});

it("a hunk that only adds blank lines is untraced, since no line counts", () => {
  const file = diffOf(["a", "b"], ["a", "", "b"]);
  const session = sessionOf([prompt, toolTurn("t1", [{ added: [""], path: PATH, removed: [] }])]);
  expect(Array.map(attributionOf([file], session).hunks, ({ traced }) => traced)).toEqual([
    "untraced",
  ]);
});

it("a hunk's mark goes on its first changed line: a removed one when it removes first", () => {
  const changedFile = diffOf(["a", "b", "c", "d"], ["a", "B", "c", "d", "e"]);
  const addedFile = diffOf(["a", "b"], ["a", "x", "b"]);
  expect(Array.map(changedFile.hunks, markLineOf)).toEqual([
    Option.some({ lineNumber: 2, side: "deletions" }),
  ]);
  expect(Array.map(addedFile.hunks, markLineOf)).toEqual([
    Option.some({ lineNumber: 2, side: "additions" }),
  ]);
});

it("each hunk's annotation carries its attribution, active when the highlighted turn wrote it", () => {
  const file = diffOf(
    Array.makeBy(20, (n) => `line ${n}`),
    Array.flatten([["top"], Array.makeBy(20, (n) => `line ${n}`), ["bottom"]]),
  );
  const session = sessionOf([
    prompt,
    toolTurn("t1", [{ added: ["top"], path: PATH, removed: [] }]),
    toolTurn("t2", [{ added: ["bottom"], path: PATH, removed: [] }]),
  ]);
  const attribution = attributionOf([file], session);
  const annotations = annotationsOf(file, attribution, Option.some("t2"));
  expect(
    Array.map(annotations, ({ lineNumber, metadata, side }) => ({
      isActive: metadata.isActive,
      lineNumber,
      side,
      turns: Array.map(metadata.attribution.turns, ({ id }) => id),
    })),
  ).toEqual([
    { isActive: false, lineNumber: 1, side: "additions", turns: ["t1"] },
    { isActive: true, lineNumber: 22, side: "additions", turns: ["t2"] },
  ]);
  expect(Record.get(attribution.turns, "t2")).toEqual(Option.some([{ index: 1, path: PATH }]));
});
