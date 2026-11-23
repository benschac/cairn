import { TaskId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, String } from "effect";

import { demoTrace } from "../src/demo.ts";
import {
  buildIndex,
  indexOf,
  search,
  searchTrace,
  type SearchContent,
  type SearchResult,
} from "../src/search.ts";
import { nodeKeyOf } from "../src/trace.ts";

/** Tasks with these titles; each has the id `t<n>` and the branch `cairn/<n>-branch`. */
const contentOf = (titles: ReadonlyArray<string>): SearchContent =>
  Array.map(titles, (title, index) => ({
    fields: [
      { kind: "title", text: title },
      { kind: "id", text: `t${index + 1}` },
      { kind: "branch", text: `cairn/${index + 1}-branch` },
    ],
    node: { id: TaskId.make(`t${index + 1}`), kind: "task" },
  }));

const titlesOf = (titles: ReadonlyArray<string>, query: string): ReadonlyArray<string> =>
  Array.map(search(buildIndex(contentOf(titles)), query), (result) => result.text);

/** Surrogate pairs, a letter that lower-cases to two code points, and mixed case. */
const Text = Schema.Array(
  Schema.Literals(["a", "B", "é", "É", "İ", "ß", "😀", "𝒜", " ", "-", "."]),
);
const textOf = (parts: typeof Text.Type): string => Array.join(parts, "");

/** No lone surrogate: every code point of the text is a whole one. */
const wellFormed = (text: string): boolean =>
  Array.every(Array.fromIterable(text), (codePoint) => {
    const unit = String.codePointAt(0)(codePoint);
    return Option.isNone(unit) || unit.value < 0xd800 || unit.value > 0xdfff;
  });

const assertValid = (results: ReadonlyArray<SearchResult>): void => {
  expect(Array.dedupeWith(results, (a, b) => nodeKeyOf(a.node) === nodeKeyOf(b.node))).toHaveLength(
    results.length,
  );
  Array.forEach(results, (result) => {
    Array.forEach(result.ranges, (range, index) => {
      expect(range.start).toBeLessThan(range.end);
      expect(range.end).toBeLessThanOrEqual(result.text.length);
      expect(wellFormed(String.slice(range.start, range.end)(result.text))).toBe(true);
      if (index > 0) {
        expect(range.start).toBeGreaterThan(result.ranges[index - 1]?.end ?? -1);
      }
    });
  });
};

it.prop(
  "results are unique, ordered the same every time and have valid source ranges",
  { query: Text, titles: Schema.Array(Text) },
  ({ query, titles }) => {
    const index = buildIndex(contentOf(Array.map(titles, textOf)));
    const results = search(index, textOf(query));
    assertValid(results);
    expect(search(index, textOf(query))).toEqual(results);
  },
);

it.prop("a title searched for by itself is found", { title: Text }, ({ title }) => {
  const query = String.trim(textOf(title));
  if (String.isNonEmpty(query)) {
    const results = search(buildIndex(contentOf([textOf(title)])), query);
    expect(Array.map(results, (result) => result.node.id)).toEqual(["t1"]);
  }
});

it("blank and unmatched queries return nothing", () => {
  const titles = ["Fuzzy matching", "Viewer"];
  expect(titlesOf(titles, "")).toEqual([]);
  expect(titlesOf(titles, " \t\n ")).toEqual([]);
  expect(titlesOf(titles, "zzzqqq")).toEqual([]);
});

it("an exact title outranks a prefix, a contiguous match, a typo and a subsequence", () => {
  expect(
    titlesOf(["a fuzzy one", "fuzzy and more", "f u z z y", "fuzzi", "fuzzy"], "FUZZY"),
  ).toEqual(["fuzzy", "fuzzy and more", "a fuzzy one", "fuzzi", "f u z z y"]);
});

it("matches abbreviations and one-edit typos of four or more characters", () => {
  const titles = ["Fuzzy matching"];
  expect(titlesOf(titles, "fzm")).toEqual(titles);
  expect(titlesOf(titles, "fuzy")).toEqual(titles);
  expect(titlesOf(titles, "fuzzzy")).toEqual(titles);
  expect(titlesOf(titles, "fuxzy")).toEqual(titles);
  expect(titlesOf(titles, "fuzzy matchign")).toEqual(titles);
  expect(titlesOf(titles, "fuzzzzy")).toEqual([]);
});

it("matches an interior adjacent transposition as a typo", () => {
  const [result] = search(buildIndex(contentOf(["matching"])), "mtaching");
  expect(result?.matchClass).toBe("typo");
});

it("a token shorter than four characters allows no typo", () => {
  expect(titlesOf(["abc"], "acb")).toEqual([]);
  expect(titlesOf(["abc"], "ac")).toEqual(["abc"]);
});

it("prefers titles, then ids, then branches, within a match class", () => {
  const index = buildIndex([
    {
      fields: [
        { kind: "title", text: "Other" },
        { kind: "id", text: "t1" },
        { kind: "branch", text: "cairn/viewer" },
      ],
      node: { id: TaskId.make("t1"), kind: "task" },
    },
    {
      fields: [
        { kind: "title", text: "viewer" },
        { kind: "id", text: "t2" },
      ],
      node: { id: TaskId.make("t2"), kind: "task" },
    },
    {
      fields: [
        { kind: "title", text: "Other" },
        { kind: "prose", text: "viewer" },
      ],
      node: { id: TaskId.make("t3"), kind: "task" },
    },
  ]);
  expect(Array.map(search(index, "viewer"), (result) => [result.node.id, result.field])).toEqual([
    ["t2", "title"],
    ["t3", "prose"],
    ["t1", "branch"],
  ]);
});

it("every token has to match within one field", () => {
  expect(titlesOf(["Fuzzy matching"], "fuzzy t1")).toEqual([]);
  expect(titlesOf(["Fuzzy matching"], "matching fuzzy")).toEqual(["Fuzzy matching"]);
});

it("matches ignoring case and maps ranges to the original text", () => {
  const [result] = search(buildIndex(contentOf(["ÉCOLE normale"])), "école");
  expect(result?.ranges).toEqual([{ end: 5, start: 0 }]);
  const [dotted] = search(buildIndex(contentOf(["İstanbul 😀 launch"])), "i");
  expect(dotted?.ranges).toEqual([{ end: 1, start: 0 }]);
  const [emoji] = search(buildIndex(contentOf(["😀 launch"])), "launch");
  expect(emoji?.ranges).toEqual([{ end: 9, start: 3 }]);
  const [pair] = search(buildIndex(contentOf(["a😀b"])), "😀b");
  expect(pair?.ranges).toEqual([{ end: 4, start: 1 }]);
});

it("treats punctuation as ordinary text", () => {
  const results = search(buildIndex(contentOf(["Spec: viewer.fuzzy-matching"])), "viewer.fuzzy-");
  expect(Array.map(results, (result) => result.ranges)).toEqual([[{ end: 19, start: 6 }]]);
  expect(titlesOf(["a"], "()[]*+?\\")).toEqual([]);
});

it("finds a sample of the demo trace's tasks by id and by title", () => {
  const index = indexOf(demoTrace);
  Array.forEach(Array.take(demoTrace.tasks, 6), (task) => {
    const results = search(index, task.id);
    assertValid(results);
    expect(
      Array.some(results, (result) => result.node.kind === "task" && result.node.id === task.id),
    ).toBe(true);
    expect(Option.map(Array.head(searchTrace(demoTrace, task.title)), (r) => r.text)).toEqual(
      Option.some(task.title),
    );
  });
});

it("reuses the index until the searchable content changes", () => {
  const first = indexOf(demoTrace);
  expect(indexOf({ ...demoTrace, sections: [] })).toBe(first);
  const renamed = {
    ...demoTrace,
    tasks: Array.map(demoTrace.tasks, (task) => ({ ...task, title: `${task.title} again` })),
  };
  expect(indexOf(renamed)).not.toBe(first);
});
