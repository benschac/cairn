import { expect, it } from "@effect/vitest";
import { SectionId, TaskId, type Trace, type TraceSection } from "@cairn/contract";
import { Array, Number, Option, Record, Schema, String, pipe } from "effect";

import { demoTrace } from "../src/demo.ts";
import { documentOf, type ProseBlock } from "../src/markdown.ts";
import {
  buildIndex,
  firstActive,
  indexOf,
  reconcileActive,
  search,
  searchTrace,
  segmentsOf,
  snippetOf,
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

// PROSE

const sectionOf = (id: string, title: string): TraceSection => ({
  human: false,
  id: Schema.decodeSync(SectionId)(id),
  keys: { context: [], defers: [], dependsOn: [], files: [], implements: [] },
  level: 2,
  line: 1,
  parent: null,
  title,
});

/** A trace whose PRD is this markdown, with a section for each id, and no spec or tasks. */
const proseTrace = (markdown: string, ids: ReadonlyArray<string>): Trace => ({
  ...demoTrace,
  prd: {
    markdown,
    path: "prd.md",
    sections: Array.map(ids, (id) => sectionOf(id, id)),
  },
  spec: { markdown: "", path: "spec.md", sections: [] },
  tasks: [],
});

const lines = (...parts: ReadonlyArray<string>): string => Array.join(parts, "\n");

const proseResults = (trace: Trace, query: string) =>
  Array.filter(searchTrace(trace, query), (result) => result.field === "prose");

const matched = (result: SearchResult): string =>
  Array.join(
    Array.map(result.ranges, (range) => pipe(result.text, String.slice(range.start, range.end))),
    "",
  );

const nested = proseTrace(
  lines(
    "# Title {#prd.title}",
    "",
    "Before any section.",
    "",
    "## Parent {#prd.parent}",
    "",
    "parent words only",
    "",
    "### Child {#prd.child}",
    "",
    "child words here",
    "",
    "more child words",
    "",
    "## Plain heading",
    "",
    "orphan words nobody owns",
  ),
  ["prd.title", "prd.parent", "prd.child"],
);

it("prose belongs to the nearest heading, nested sections own their text and unowned text is not searched", () => {
  const document = documentOf(nested.prd.markdown);
  expect(
    Record.map(document.proseOf, (blocks) => Array.map(blocks, (block) => block.text)),
  ).toEqual({
    "prd.child": ["child words here", "more child words"],
    "prd.parent": ["parent words only"],
    "prd.title": ["Before any section."],
  });
  expect(Array.map(proseResults(nested, "words"), (result) => result.node.id)).toEqual([
    "prd.child",
    "prd.parent",
  ]);
  expect(proseResults(nested, "orphan")).toEqual([]);
});

it("a match runs across emphasis, a link and inline code, and the text is what a reader sees", () => {
  const trace = proseTrace(
    "## S {#prd.s}\n\nUse `inline code` with **bold** and [a link](https://dest.example/hiddenpath) and \\*escaped\\* 😀 end.",
    ["prd.s"],
  );
  const [block] = Option.getOrThrow(Record.get(documentOf(trace.prd.markdown).proseOf, "prd.s"));
  expect(block?.text).toBe("Use inline code with bold and a link and *escaped* 😀 end.");
  const [result] = proseResults(trace, "code with bold and a link");
  expect(result?.text).toBe(block?.text);
  expect(result === undefined ? "" : matched(result)).toBe("code with bold and a link");
  expect(result?.matchClass).toBe("contiguous");
  const [escaped] = proseResults(trace, "*escaped* 😀 end");
  expect(escaped === undefined ? "" : matched(escaped)).toBe("*escaped* 😀 end");
  // The link's destination is not text.
  expect(proseResults(trace, "hiddenpath")).toEqual([]);
});

it("each table cell is its own block, so a query does not cross cells", () => {
  const trace = proseTrace(
    lines("## T {#prd.t}", "", "| left | right |", "| --- | --- |", "| alpha | beta **gamma** |"),
    ["prd.t"],
  );
  expect(
    Array.map(
      Option.getOrThrow(Record.get(documentOf(trace.prd.markdown).proseOf, "prd.t")),
      (block) => block.text,
    ),
  ).toEqual(["left", "right", "alpha", "beta gamma"]);
  expect(proseResults(trace, "beta gamma")).toHaveLength(1);
  expect(proseResults(trace, "alpha beta")).toEqual([]);
  expect(proseResults(trace, "right alpha")).toEqual([]);
});

it("comments, code fences, diagrams, key lists and heading ids are not prose", () => {
  const trace = proseTrace(
    lines(
      "## Section {#prd.hidden-id}",
      "",
      "- Implements: `prd.keyed`",
      "",
      "<!-- commentword -->",
      "",
      "```ts",
      "const fencedword = 1;",
      "```",
      "",
      "```mermaid",
      "graph TD; diagramword --> other",
      "```",
      "",
      "<div>htmlword</div>",
      "",
      "Visible paragraph.",
    ),
    ["prd.hidden-id"],
  );
  const texts = Array.map(
    Option.getOrThrow(Record.get(documentOf(trace.prd.markdown).proseOf, "prd.hidden-id")),
    (block) => block.text,
  );
  expect(texts).toEqual(["Visible paragraph."]);
  Array.forEach(["commentword", "fencedword", "diagramword", "htmlword", "keyed"], (word) => {
    expect(proseResults(trace, word)).toEqual([]);
  });
  // The heading's id attribute is not part of its title; the id field still finds the section.
  expect(documentOf(trace.prd.markdown).headings["prd.hidden-id"]?.text).toBe("Section");
  expect(Array.map(searchTrace(trace, "hidden-id"), (result) => result.field)).toEqual(["id"]);
});

it("a line break reads as a space, so a phrase matches across it", () => {
  const trace = proseTrace("## S {#prd.s}\n\nalpha\nbeta  gamma", ["prd.s"]);
  const [result] = proseResults(trace, "alpha beta");
  expect(result?.matchClass).toBe("prefix");
  expect(result === undefined ? "" : matched(result)).toBe("alpha\nbeta");
});

it("a section's title is its heading as shown, so a formatted heading matches and marks cleanly", () => {
  const [result] = searchTrace(demoTrace, "cairn ids");
  expect(result?.field).toBe("title");
  expect(result?.text).toBe("cairn ids");
  expect(result?.matchClass).toBe("exact");
  expect(result?.maybeBlock).toEqual(Option.some("heading:spec.sections.cairn-ids"));
  expect(
    Option.map(
      Array.findFirst(
        demoTrace.spec.sections,
        (section) => section.id === "spec.sections.cairn-ids",
      ),
      (section) => section.title,
    ),
  ).toEqual(Option.some("`cairn ids`"));
});

it("a node's result is its best block: a title beats prose, and the best of several paragraphs wins", () => {
  const trace = proseTrace(
    lines(
      "## Overview {#prd.s}",
      "",
      "the planning of things",
      "",
      "planning",
      "",
      "planning in a very long paragraph with many many other words around it",
    ),
    ["prd.s"],
  );
  const results = searchTrace(trace, "planning");
  expect(results).toHaveLength(1);
  expect(results[0]?.field).toBe("prose");
  expect(results[0]?.text).toBe("planning");
  expect(results[0]?.matchClass).toBe("exact");
  const titled = searchTrace(
    proseTrace(lines("## Planning {#prd.s}", "", "planning"), ["prd.s"]),
    "planning",
  );
  // The heading's title is the same class as the paragraph and ranks above it.
  expect(Array.map(titled, (result) => result.field)).toEqual(["title"]);
});

it("query edits and refreshes reuse the parsed documents", () => {
  const prd = documentOf(demoTrace.prd.markdown);
  const spec = documentOf(demoTrace.spec.markdown);
  searchTrace(demoTrace, "redact");
  searchTrace(demoTrace, "redacts");
  searchTrace({ ...demoTrace, sections: [] }, "redact");
  expect(documentOf(demoTrace.prd.markdown)).toBe(prd);
  expect(documentOf(demoTrace.spec.markdown)).toBe(spec);
  expect(prd.tree).not.toBe(spec.tree);
});

/** The offsets of each heading in a document's source, and where the document ends. */
const sectionSpansOf = (
  markdown: string,
): Record.ReadonlyRecord<string, readonly [number, number]> => {
  const document = documentOf(markdown);
  const starts = Array.getSomes(
    Array.map(document.tree.children, (child) =>
      child.type === "heading" ? Option.fromNullishOr(child.position?.start.offset) : Option.none(),
    ),
  );
  return Record.map(document.headings, (heading) => [
    heading.source.start,
    Option.getOrElse(
      Array.findFirst(starts, (start) => start > heading.source.start),
      () => String.length(markdown),
    ),
  ]);
};

const proseWords = Array.dedupe(
  Array.filter(
    Array.flatMap(
      Array.flatten(Record.values(documentOf(demoTrace.spec.markdown).proseOf)),
      (block) => String.split(block.text, /[^\p{L}\p{N}]+/u),
    ),
    (word) => String.length(word) >= 3,
  ),
);

const spans = Record.union(
  sectionSpansOf(demoTrace.prd.markdown),
  sectionSpansOf(demoTrace.spec.markdown),
  (own) => own,
);
const demoBlocks = Array.flatMap([demoTrace.prd.markdown, demoTrace.spec.markdown], (markdown) =>
  Array.flatten(Record.values(documentOf(markdown).proseOf)),
);

const Pick = Schema.Struct({
  drop: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 })),
  word: Schema.Int.check(Schema.isBetween({ maximum: Array.length(proseWords) - 1, minimum: 0 })),
});

it.prop(
  "every range of a prose result maps back to text in the section that owns it",
  { picks: Schema.Array(Pick).check(Schema.isMinLength(1), Schema.isMaxLength(2)) },
  ({ picks }) => {
    const query = Array.join(
      Array.map(picks, ({ drop, word }) => {
        const text = Option.getOrElse(Array.get(proseWords, word), () => "");
        // Dropping a character makes a typo, so the matched word differs from the query.
        return drop < String.length(text) && drop % 2 === 1
          ? pipe(text, String.slice(0, drop)) + pipe(text, String.slice(drop + 1))
          : text;
      }),
      " ",
    );
    Array.forEach(proseResults(demoTrace, query), (result) => {
      const block = Option.getOrThrow(
        Array.findFirst(demoBlocks, (candidate) =>
          Option.exists(result.maybeBlock, (key) => key === candidate.key),
        ),
      ) satisfies ProseBlock;
      const [from, to] = Option.getOrThrow(Record.get(spans, result.node.id));
      expect(block.owner).toBe(result.node.id);
      expect(result.text).toBe(block.text);
      assertValid([result]);
      Array.forEach(result.ranges, (range) => {
        const pieces = Array.filter(
          block.leaves,
          (leaf) => leaf.end > range.start && leaf.start < range.end,
        );
        // A range is inside the block's text, and the text it covers comes from leaves of the section.
        expect(pieces.length).toBeGreaterThan(0);
        Array.forEach(pieces, (leaf) => {
          const at = leaf.sourceStart + Number.max(range.start - leaf.start, 0);
          expect(at).toBeGreaterThanOrEqual(from);
          expect(at).toBeLessThan(to);
        });
      });
      expect(
        Array.join(
          Array.map(segmentsOf(result.text, result.ranges), (segment) => segment.text),
          "",
        ),
      ).toBe(block.text);
    });
  },
  // Each sample searches both documents of the demo trace.
  { arbitrary: { runs: 12 } },
);

const Filler = Schema.Literals(["a", "😀", "é ", "ab😀 ", "İ"]);

it.prop(
  "a snippet is bounded, whole characters around the match, and its ranges are the match",
  {
    filler: Filler,
    lead: Schema.Int.check(Schema.isBetween({ maximum: 150, minimum: 0 })),
    trail: Schema.Int.check(Schema.isBetween({ maximum: 150, minimum: 0 })),
  },
  ({ filler, lead, trail }) => {
    const before = Array.join(
      Array.makeBy(lead, () => filler),
      "",
    );
    const after = Array.join(
      Array.makeBy(trail, () => filler),
      "",
    );
    const text = before + "needle" + after;
    const start = String.length(before);
    const snippet = snippetOf(text, [{ end: start + 6, start }]);
    expect(wellFormed(snippet.text)).toBe(true);
    expect(String.length(snippet.text)).toBeLessThanOrEqual(122);
    expect(snippet.ranges).toHaveLength(1);
    expect(
      Array.join(
        Array.map(snippet.ranges, (range) =>
          pipe(snippet.text, String.slice(range.start, range.end)),
        ),
        "",
      ),
    ).toBe("needle");
    const body = pipe(snippet.text, String.replaceAll("…", ""));
    expect(String.includes(body)(text)).toBe(true);
    if (String.length(text) <= 120) {
      expect(snippet).toEqual({ ranges: [{ end: start + 6, start }], text });
    }
  },
);

it("a snippet of a long paragraph in the demo trace shows the match in its context", () => {
  const [result] = proseResults(demoTrace, "extract paragraphs list items table cells");
  expect(result?.field).toBe("prose");
  expect(String.length(result?.text ?? "")).toBeGreaterThan(120);
  expect(String.length(result?.snippet.text ?? "")).toBeLessThanOrEqual(122);
  // Each word is matched where it is, so the ranges are the words and not the punctuation between.
  expect(result === undefined ? "" : matched(result)).toBe("Extractparagraphslistitemstablecells");
  expect(
    Array.join(
      Array.map(result?.snippet.ranges ?? [], (range) =>
        pipe(result?.snippet.text ?? "", String.slice(range.start, range.end)),
      ),
      "",
    ),
  ).toBe("Extractparagraphslistitemstablecells");
});
