import { SectionId, TaskId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Record, Schema, String } from "effect";

import { demoTrace } from "../src/demo.ts";
import { documentOf } from "../src/markdown.ts";
import { segmentsOf } from "../src/range.ts";
import {
  buildIndex,
  fieldOf,
  indexOf,
  search,
  searchTrace,
  snippetOf,
  type SearchContent,
  type SearchResult,
} from "../src/search.ts";
import { nodeKeyOf } from "../src/trace.ts";

/** Tasks with these titles; each has the id `t<n>` and the branch `cairn/<n>-branch`. */
const contentOf = (titles: ReadonlyArray<string>): SearchContent =>
  Array.map(titles, (title, index) => ({
    fields: [
      fieldOf("title", title),
      fieldOf("id", `t${index + 1}`),
      fieldOf("branch", `cairn/${index + 1}-branch`),
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
      fields: [fieldOf("title", "Other"), fieldOf("id", "t1"), fieldOf("branch", "cairn/viewer")],
      node: { id: TaskId.make("t1"), kind: "task" },
    },
    {
      fields: [fieldOf("title", "viewer"), fieldOf("id", "t2")],
      node: { id: TaskId.make("t2"), kind: "task" },
    },
    {
      fields: [fieldOf("title", "Other"), fieldOf("prose", "viewer")],
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

it.prop(
  "the segments of a result's text rejoin to the text, and the marked ones are its ranges",
  { query: Text, titles: Schema.Array(Text) },
  ({ query, titles }) => {
    Array.forEach(
      search(buildIndex(contentOf(Array.map(titles, textOf))), textOf(query)),
      (result) => {
        const segments = segmentsOf(result.text, result.ranges);
        expect(
          Array.join(
            Array.map(segments, (segment) => segment.text),
            "",
          ),
        ).toBe(result.text);
        expect(
          Array.map(
            Array.filter(segments, (segment) => segment.isMatch),
            (segment) => segment.text,
          ),
        ).toEqual(
          Array.map(result.ranges, (range) => String.slice(range.start, range.end)(result.text)),
        );
        expect(Array.every(segments, (segment) => String.isNonEmpty(segment.text))).toBe(true);
      },
    );
  },
);

// PROSE

const sectionId = Schema.decodeSync(SectionId);

/** One entry per section with prose, its paragraphs, list items and cells as the fields. */
const proseContentOf = (markdown: string): SearchContent =>
  Array.map(Record.toEntries(documentOf(markdown).blocks), ([id, blocks]) => ({
    fields: Array.map(blocks, (block) => ({
      kind: "prose" as const,
      maybeOffset: Option.some(block.offset),
      text: block.text,
    })),
    node: { id: sectionId(id), kind: "section" as const },
  }));

const lines = (parts: ReadonlyArray<string>): string => Array.join(parts, "\n");

const FENCE = "```";

const nested = lines([
  "## Outer {#spec.outer}",
  "",
  "Outer paragraph about **zebra** crossing.",
  "",
  "- list item with `inline code` here",
  "",
  "| Head | Other |",
  "| ---- | ----- |",
  "| cell alpha | cell **beta** |",
  "",
  "### Inner {#spec.inner}",
  "",
  "Inner paragraph with \\*escaped\\* stars and 😀 emoji.",
  "",
  "<!-- hidden comment words -->",
  "",
  `${FENCE}ts`,
  'const fenced = "secret fence";',
  FENCE,
  "",
  `${FENCE}mermaid`,
  "graph TD; Diagram --> Label",
  FENCE,
  "",
  "## Next {#spec.next}",
  "",
  "- Files: `apps/destination.ts`",
  "",
  "Next text with [a label](https://example.com/destination).",
]);

const proseIndex = buildIndex(proseContentOf(nested));
const foundIn = (query: string) =>
  Array.map(search(proseIndex, query), (result) => [result.node.id, result.text] as const);

it("a result is one section with its best block, and nested sections own their own text", () => {
  expect(foundIn("zebra")).toEqual([["spec.outer", "Outer paragraph about zebra crossing."]]);
  expect(foundIn("emoji")).toEqual([
    ["spec.inner", "Inner paragraph with *escaped* stars and 😀 emoji."],
  ]);
  // The parent's text is not repeated under the nested heading, nor the child's under the parent.
  expect(Array.map(foundIn("paragraph"), ([id]) => id)).toEqual(["spec.outer", "spec.inner"]);
});

it("matches inside a paragraph across inline markup, list items, cells and inline code", () => {
  expect(foundIn("about zebra crossing")).toEqual([
    ["spec.outer", "Outer paragraph about zebra crossing."],
  ]);
  expect(foundIn("inline code here")).toEqual([["spec.outer", "list item with inline code here"]]);
  expect(foundIn("cell beta")).toEqual([["spec.outer", "cell beta"]]);
  expect(foundIn("a label")).toEqual([["spec.next", "Next text with a label."]]);
});

it("prose ranges are valid code unit offsets of the visible text after emoji and escapes", () => {
  const [result] = search(proseIndex, "stars and");
  expect(result?.text).toBe("Inner paragraph with *escaped* stars and 😀 emoji.");
  expect(
    Array.map(result?.ranges ?? [], (range) =>
      String.slice(range.start, range.end)(result?.text ?? ""),
    ),
  ).toEqual(["stars and"]);
  const [emoji] = search(proseIndex, "emoji");
  expect(emoji?.ranges).toEqual([{ end: 49, start: 44 }]);
});

it("comments, code fences, diagram labels, link destinations and key lists do not match", () => {
  Array.forEach(
    ["hidden", "secret", "fenced", "Diagram", "destination", "apps/", "spec.outer"],
    (query) => {
      expect(foundIn(query)).toEqual([]);
    },
  );
});

it("a match does not cross a block or a section", () => {
  expect(foundIn("alpha beta")).toEqual([]);
  expect(foundIn("zebra alpha")).toEqual([]);
  expect(foundIn("crossing Inner")).toEqual([]);
  expect(foundIn("alpha")).toEqual([["spec.outer", "cell alpha"]]);
});

it("a typo in prose marks the whole word, and prose has no abbreviations", () => {
  const [typo] = search(proseIndex, "zebrra");
  expect(typo?.matchClass).toBe("typo");
  expect(
    Array.map(typo?.ranges ?? [], (range) =>
      String.slice(range.start, range.end)(typo?.text ?? ""),
    ),
  ).toEqual(["zebra"]);
  expect(foundIn("zbc")).toEqual([]);
  // A title is short enough for an abbreviation.
  expect(titlesOf(["zebra crossing"], "zbc")).toEqual(["zebra crossing"]);
  const [title] = search(buildIndex(contentOf(["Fuzzy matching"])), "fuzy");
  expect(title?.ranges).toEqual([{ end: 5, start: 0 }]);
});

it("a section's best block is the best match, and a title outranks prose of the same class", () => {
  const index = buildIndex([
    {
      fields: [
        fieldOf("title", "Other"),
        { kind: "prose", maybeOffset: Option.some(10), text: "an alpha later" },
        { kind: "prose", maybeOffset: Option.some(30), text: "alpha first" },
      ],
      node: { id: TaskId.make("t1"), kind: "task" },
    },
    {
      fields: [fieldOf("title", "alpha"), fieldOf("id", "t2")],
      node: { id: TaskId.make("t2"), kind: "task" },
    },
  ]);
  const results = search(index, "alpha");
  expect(Array.map(results, (result) => result.node.id)).toEqual(["t2", "t1"]);
  expect(results[1]?.maybeOffset).toEqual(Option.some(30));
});

const only = (results: ReadonlyArray<SearchResult>): SearchResult =>
  Option.getOrThrow(Array.head(results));

const longText = (middle: string) =>
  `${Array.join(
    Array.makeBy(40, () => "word"),
    " ",
  )} ${middle} ${Array.join(
    Array.makeBy(40, () => "word"),
    " ",
  )}`;

it("a snippet is bounded, holds the first match and cuts its ranges to itself", () => {
  const text = longText("needle");
  const result = only(
    search(
      buildIndex([
        {
          fields: [{ kind: "prose", maybeOffset: Option.some(0), text }],
          node: { id: TaskId.make("t1"), kind: "task" },
        },
      ]),
      "needle",
    ),
  );
  const snippet = snippetOf(result);
  expect(snippet.text.length).toBeLessThanOrEqual(120);
  expect(snippet.isCutBefore && snippet.isCutAfter).toBe(true);
  expect(
    Array.map(snippet.ranges, (range) => String.slice(range.start, range.end)(snippet.text)),
  ).toEqual(["needle"]);
  expect(text).toContain(snippet.text);
  // A short text is its own snippet.
  const short = only(search(buildIndex(contentOf(["Fuzzy matching"])), "fuzzy"));
  expect(snippetOf(short)).toEqual({
    isCutAfter: false,
    isCutBefore: false,
    ranges: [{ end: 5, start: 0 }],
    text: "Fuzzy matching",
  });
});

it.prop(
  "a snippet never splits a surrogate pair and its ranges are its own",
  {
    before: Schema.Int.check(Schema.isBetween({ maximum: 90, minimum: 0 })),
    count: Schema.Int.check(Schema.isBetween({ maximum: 150, minimum: 1 })),
  },
  ({ before, count }) => {
    const text = `${Array.join(
      Array.makeBy(before, () => "a"),
      "",
    )}${Array.join(
      Array.makeBy(count, () => "😀"),
      "",
    )}needle${Array.join(
      Array.makeBy(count, () => "😀"),
      "",
    )}`;
    const found = only(
      search(
        buildIndex([
          {
            fields: [{ kind: "prose", maybeOffset: Option.some(0), text }],
            node: { id: TaskId.make("t1"), kind: "task" },
          },
        ]),
        "needle",
      ),
    );
    const snippet = snippetOf(found);
    expect(wellFormed(snippet.text)).toBe(true);
    expect(snippet.text.length).toBeLessThanOrEqual(121);
    expect(
      Array.map(snippet.ranges, (range) => String.slice(range.start, range.end)(snippet.text)),
    ).toEqual(["needle"]);
  },
);

it.prop(
  "every prose result is a block of its section and its ranges are valid text offsets",
  { paragraphs: Schema.Array(Text), query: Text },
  ({ paragraphs, query }) => {
    const markdown = lines(
      Array.flatMap(paragraphs, (parts, index) => [
        `## S${index} {#spec.s${index}}`,
        "",
        `w${textOf(parts)}w`,
        "",
      ]),
    );
    const { blocks } = documentOf(markdown);
    const results = search(buildIndex(proseContentOf(markdown)), textOf(query));
    assertValid(results);
    Array.forEach(results, (result) => {
      expect(
        Array.some(
          Option.getOrElse(Record.get(blocks, result.node.id), () => []),
          (block) =>
            block.text === result.text &&
            Option.exists(result.maybeOffset, (offset) => offset === block.offset),
        ),
      ).toBe(true);
    });
  },
);

it("query changes reuse the parsed documents and the index", () => {
  const spec = documentOf(demoTrace.spec.markdown);
  const prd = documentOf(demoTrace.prd.markdown);
  const first = indexOf(demoTrace);
  Array.forEach(["f", "fu", "fuz", "fuzzy", "fuzzy sear"], (query) => {
    searchTrace(demoTrace, query);
  });
  expect(documentOf(demoTrace.spec.markdown)).toBe(spec);
  expect(documentOf(demoTrace.prd.markdown)).toBe(prd);
  expect(indexOf(demoTrace)).toBe(first);
});

it("the demo trace's prose is searchable, and a section's title is the one it renders", () => {
  const title = only(searchTrace(demoTrace, "cairn plan"));
  expect(title.field).toBe("title");
  expect(title.text).toBe("cairn plan");
  const found = searchTrace(demoTrace, "mermaid fence draws");
  expect(found.length).toBeGreaterThan(0);
  expect(Array.every(found, (each) => each.field === "prose")).toBe(true);
  assertValid(found);
});
