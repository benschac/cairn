import { expect, it } from "@effect/vitest";
import { TaskId } from "@cairn/contract";
import { Array, Option, Schema, String, pipe } from "effect";

import { demoTrace } from "../src/demo.ts";
import {
  buildIndex,
  firstActive,
  indexOf,
  reconcileActive,
  search,
  searchTrace,
  segmentsOf,
  stepActive,
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
const Parts = Schema.Array(
  Schema.Literals(["a", "B", "é", "É", "İ", "ß", "😀", "𝒜", " ", "-", "."]),
);
const textOf = (parts: ReadonlyArray<string>): string => Array.join(parts, "");

const wellFormed = (text: string): boolean => Option.isNone(String.match(/\p{Surrogate}/u)(text));

const assertValid = (results: ReadonlyArray<SearchResult>): void => {
  expect(Array.dedupeWith(results, (a, b) => nodeKeyOf(a.node) === nodeKeyOf(b.node))).toHaveLength(
    results.length,
  );
  Array.forEach(results, (result) => {
    Array.forEach(result.ranges, (range, index) => {
      expect(range.start).toBeLessThan(range.end);
      expect(range.end).toBeLessThanOrEqual(result.text.length);
      expect(wellFormed(pipe(result.text, String.slice(range.start, range.end)))).toBe(true);
      if (index > 0) {
        expect(range.start).toBeGreaterThan(result.ranges[index - 1]?.end ?? -1);
      }
    });
  });
};

it.prop(
  "results are unique, ordered the same every time and have valid source ranges",
  { query: Parts, titles: Schema.Array(Parts) },
  (generated) => {
    const query = textOf(generated.query);
    const titles = Array.map(generated.titles, textOf);
    const index = buildIndex(contentOf(titles));
    const results = search(index, query);
    assertValid(results);
    expect(search(index, query)).toEqual(results);
  },
);

it.prop("a title searched for by itself is found", { parts: Parts }, ({ parts }) => {
  const title = textOf(parts);
  const query = String.trim(title);
  if (String.isNonEmpty(query)) {
    const results = search(buildIndex(contentOf([title])), query);
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

it("folds Greek final sigma so ΟΣ, ος and σ match alike", () => {
  expect(titlesOf(["ΟΣ", "ΛΟΓΟΣ"], "ος")).toEqual(["ΟΣ", "ΛΟΓΟΣ"]);
  expect(titlesOf(["λόγος"], "λόγοσ")).toEqual(["λόγος"]);
  const [result] = search(buildIndex(contentOf(["ΛΟΓΟΣ"])), "λογος");
  expect(result?.matchClass).toBe("exact");
  expect(result?.ranges).toEqual([{ end: 5, start: 0 }]);
});

it("treats punctuation as ordinary text", () => {
  const results = search(buildIndex(contentOf(["Spec: viewer.fuzzy-matching"])), "viewer.fuzzy-");
  expect(Array.map(results, (result) => result.ranges)).toEqual([[{ end: 19, start: 6 }]]);
  expect(titlesOf(["a"], "()[]*+?\\")).toEqual([]);
});

it("finds the first tasks of the demo trace by its title and id", () => {
  const index = indexOf(demoTrace);
  expect(Array.map(searchTrace(demoTrace, "t1"), (r) => r.node.kind)).toContain("task");
  Array.forEach(Array.take(demoTrace.tasks, 12), (task) => {
    const results = search(index, task.id);
    assertValid(results);
    expect(
      Array.some(results, (result) => result.node.kind === "task" && result.node.id === task.id),
    ).toBe(true);
    expect(Option.map(Array.head(search(index, task.title)), (r) => r.text)).toEqual(
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

it.prop(
  "a result's segments join back into its text, and the marked ones are exactly its ranges",
  { query: Parts, titles: Schema.Array(Parts) },
  (generated) => {
    const query = textOf(generated.query);
    const results = search(buildIndex(contentOf(Array.map(generated.titles, textOf))), query);
    Array.forEach(results, (result) => {
      const segments = segmentsOf(result.text, result.ranges);
      expect(
        Array.join(
          Array.map(segments, (segment) => segment.text),
          "",
        ),
      ).toBe(result.text);
      expect(
        Array.join(
          Array.map(
            Array.filter(segments, (segment) => segment.isMatch),
            (segment) => segment.text,
          ),
          "",
        ),
      ).toBe(
        Array.join(
          Array.map(result.ranges, (range) =>
            pipe(result.text, String.slice(range.start, range.end)),
          ),
          "",
        ),
      );
      expect(Array.every(segments, (segment) => String.isNonEmpty(segment.text))).toBe(true);
    });
  },
);

it("segments of text with no ranges are the text, and of nothing are none", () => {
  expect(segmentsOf("abc", [])).toEqual([{ isMatch: false, text: "abc" }]);
  expect(segmentsOf("", [])).toEqual([]);
  expect(segmentsOf("abcd", [{ end: 2, start: 1 }])).toEqual([
    { isMatch: false, text: "a" },
    { isMatch: true, text: "b" },
    { isMatch: false, text: "cd" },
  ]);
});

const Steps = Schema.Array(Schema.Literals([1, -1] as const));

it.prop(
  "arrow steps stay on the results, stop at both ends and never move against their direction",
  { steps: Steps, titles: Schema.Array(Parts), query: Parts },
  (generated) => {
    const results = search(
      buildIndex(contentOf(Array.map(generated.titles, textOf))),
      textOf(generated.query),
    );
    const order = Array.map(results, (result) => result.node.id);
    Array.reduce(generated.steps, firstActive(results), (maybeActive, step) => {
      const next = stepActive(results, maybeActive, step);
      Option.match(next, {
        onNone: () => expect(results).toEqual([]),
        onSome: (node) => {
          const from = Option.flatMap(maybeActive, (active) =>
            Array.findFirstIndex(order, (id) => id === active.id),
          );
          const to = Array.findFirstIndex(order, (id) => id === node.id);
          expect(Option.isSome(to)).toBe(true);
          Option.match(Option.all({ from, to }), {
            onNone: () => undefined,
            onSome: ({ from: at, to: now }) => {
              expect(now).toBe(Math.min(Math.max(at + step, 0), order.length - 1));
            },
          });
        },
      });
      return next;
    });
  },
);

it("an active node that still matches is kept, and otherwise the first result is chosen", () => {
  const results = search(buildIndex(contentOf(["alpha one", "alpha two", "alpha three"])), "alpha");
  const second = Option.getOrThrow(Array.get(results, 1)).node;
  expect(reconcileActive(results, Option.some(second))).toEqual(Option.some(second));
  expect(reconcileActive(Array.drop(results, 2), Option.some(second))).toEqual(
    firstActive(Array.drop(results, 2)),
  );
  expect(reconcileActive(results, Option.none())).toEqual(firstActive(results));
  expect(reconcileActive([], Option.some(second))).toEqual(Option.none());
  expect(stepActive([], Option.none(), 1)).toEqual(Option.none());
});
