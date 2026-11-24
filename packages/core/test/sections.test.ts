import { Section, SectionPrefix } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Record, Schema, String, pipe } from "effect";

import { assignSectionIds, sectionIdsOf, sectionsOf } from "../src/index.ts";

const Prd = Schema.Literals(["prd.goal", "prd.section-ids", "prd.viewer"]);
const Spec = Schema.Literals(["spec.format", "spec.sections.parsing"]);
const Path = Schema.Literals(["packages/core/src/", "packages/core/src/sections.ts", "README.md"]);
const Title = Schema.Literals(["Saved views", "Schéma & données", "!!!", "2 phases", "API"]);

const Keys = Schema.Struct({
  context: Schema.Array(Prd),
  defers: Schema.Array(Prd),
  dependsOn: Schema.Array(Spec),
  files: Schema.Array(Path),
  implements: Schema.Array(Prd),
});
type Keys = typeof Keys.Type;

/** A section as a spec writes it: heading, optional marker, key list, then prose that may hold decoys. */
const Draft = Schema.Struct({
  decoy: Schema.Boolean,
  human: Schema.Literals(["none", "before-keys", "in-prose"]),
  identified: Schema.Boolean,
  keys: Keys,
  late: Schema.Boolean,
  level: Schema.Literals([1, 2, 3, 4]),
  title: Title,
});
type Draft = typeof Draft.Type;

const MARKER = "<!-- human -->";

const keyLines = (keys: Keys): readonly string[] =>
  Array.flatMap(
    [
      ["Implements", keys.implements],
      ["Files", keys.files],
      ["Depends on", keys.dependsOn],
      ["Defers", keys.defers],
      ["Context", keys.context],
    ] as const,
    ([name, values]) =>
      Array.isReadonlyArrayNonEmpty(values)
        ? [
            `- ${name}: ${Array.join(
              Array.map(values, (value) => `\`${value}\``),
              ", ",
            )}`,
          ]
        : [],
  );

const idOf = (index: number): string => `spec.s${index}`;

/** The lines a draft is written as. The prose quotes the marker in a code span; the decoy holds a heading, a marker and a key line inside a fence; an in-prose marker sits at the end of a sentence. */
const linesOfDraft = (draft: Draft, index: number): readonly string[] =>
  Array.flatten([
    [
      `${String.repeat(draft.level)("#")} ${draft.title}${draft.identified ? ` {#${idOf(index)}}` : ""}`,
      "",
    ],
    draft.human === "before-keys" ? [MARKER, ""] : [],
    keyLines(draft.keys),
    ["", "Prose that quotes `<!-- human -->` in a code span."],
    draft.decoy ? ["```", "## Decoy {#spec.decoy}", MARKER, "- Files: `decoy/`", "```"] : [],
    draft.late ? ["- Files: `late/`"] : [],
    draft.human === "in-prose" ? [`Needs approval. ${MARKER}`] : [],
  ]);

const Document = {
  drafts: Schema.Array(Draft),
  preamble: Schema.Array(Schema.Literals(["Intro", ""])),
};

const parentIndexOf = (drafts: readonly Draft[], index: number): Option.Option<number> =>
  pipe(
    Array.get(drafts, index),
    Option.flatMap((draft) =>
      Array.findLastIndex(Array.take(drafts, index), (above) => above.level < draft.level),
    ),
  );

/** Keys by name; the oracle works on values only, so it needs no per-key types. */
type KeyMap = Readonly<Record<string, readonly string[]>>;

const ownKeysOf = (draft: Draft): KeyMap =>
  Record.map(draft.keys, (values) => Array.dedupe(values));

/** What the key rules in `spec.format` say a section holds: what its parent holds, then its own. */
const keysOf = (drafts: readonly Draft[], index: number): KeyMap =>
  pipe(
    Array.get(drafts, index),
    Option.map(ownKeysOf),
    Option.map((own) =>
      Option.match(parentIndexOf(drafts, index), {
        onNone: () => own,
        onSome: (parent) =>
          Record.union(keysOf(drafts, parent), own, (above, here) =>
            Array.dedupe(Array.appendAll(above, here)),
          ),
      }),
    ),
    Option.getOrThrow,
  );

const humanOf = (drafts: readonly Draft[], index: number): boolean =>
  Option.exists(Array.get(drafts, index), (draft) => draft.human !== "none") ||
  Option.exists(parentIndexOf(drafts, index), (parent) => humanOf(drafts, parent));

const parentIdOf = (drafts: readonly Draft[], index: number): string | undefined =>
  pipe(
    parentIndexOf(drafts, index),
    Option.flatMap((parent) =>
      Option.exists(Array.get(drafts, parent), (draft) => draft.identified)
        ? Option.some(idOf(parent))
        : Option.fromUndefinedOr(parentIdOf(drafts, parent)),
    ),
    Option.getOrUndefined,
  );

const written = (drafts: readonly Draft[], preamble: readonly string[]) => {
  const blocks = Array.map(drafts, linesOfDraft);
  const starts = Array.scan(
    Array.map(blocks, Array.length),
    preamble.length,
    (total, size) => total + size,
  );
  return {
    blocks,
    markdown: Array.join(Array.appendAll(preamble, Array.flatten(blocks)), "\n"),
    starts,
  };
};

it.prop(
  "each heading becomes a section with its keys, marker and parent from the heading tree",
  Document,
  ({ drafts, preamble }) => {
    const { blocks, markdown, starts } = written(drafts, preamble);
    const expected = Array.map(drafts, (draft, index) => ({
      body: pipe(
        Array.get(blocks, index),
        Option.map((lines) => Array.join(Array.drop(lines, 1), "\n")),
        Option.getOrThrow,
      ),
      human: humanOf(drafts, index),
      id: draft.identified ? idOf(index) : undefined,
      keys: keysOf(drafts, index),
      level: draft.level,
      line: pipe(Array.get(starts, index), Option.getOrThrow) + 1,
      parent: parentIdOf(drafts, index),
      title: draft.title,
    }));
    expect(sectionsOf(markdown)).toEqual(expected);
  },
);

it.prop("every section decodes as a Section", Document, ({ drafts, preamble }) => {
  const sections = sectionsOf(written(drafts, preamble).markdown);
  expect(Array.every(sections, Schema.is(Section))).toBe(true);
});

it.prop(
  "a key below the prose, and anything inside a fence, is not read",
  Document,
  ({ drafts, preamble }) => {
    const sections = sectionsOf(written(drafts, preamble).markdown);
    expect(Array.some(sections, ({ keys }) => Array.contains(keys.files, "decoy/"))).toBe(false);
    expect(Array.some(sections, ({ keys }) => Array.contains(keys.files, "late/"))).toBe(false);
    expect(Array.some(sections, ({ id }) => id === "spec.decoy")).toBe(false);
  },
);

const Line = Schema.TaggedUnion({
  fence: {},
  heading: { level: Schema.Literals([1, 2, 3, 4]), text: Title },
  identified: {
    id: Schema.Literals(["prd.saved-views", "spec.saved-views.persist", "prd.api"]),
    level: Schema.Literals([2, 3]),
    text: Title,
  },
  marker: {},
  prose: { text: Title },
});

const renderLine = Line.match({
  fence: () => "```",
  heading: ({ level, text }) => `${String.repeat(level)("#")} ${text}`,
  identified: ({ id, level, text }) => `${String.repeat(level)("#")} ${text} {#${id}}`,
  marker: () => MARKER,
  prose: ({ text }) => `${text} # not a heading`,
});

it.prop(
  "sectionsOf and assignSectionIds agree on what a heading is",
  { lines: Schema.Array(Line), prefix: SectionPrefix },
  ({ lines, prefix }) => {
    const markdown = Array.join(Array.map(lines, renderLine), "\n");
    const before = sectionsOf(markdown);
    const assigned = assignSectionIds(markdown, prefix);
    const after = sectionsOf(assigned.markdown);
    expect(Array.map(after, ({ id }) => id)).toEqual(sectionIdsOf(assigned.markdown));
    expect(Array.every(after, ({ id }) => id !== undefined)).toBe(true);
    expect(Array.map(after, ({ title }) => title)).toEqual(Array.map(before, ({ title }) => title));
    expect(Array.map(after, ({ line }) => line)).toEqual(Array.map(before, ({ line }) => line));
    expect(Array.map(after, ({ level }) => level)).toEqual(Array.map(before, ({ level }) => level));
  },
);

const spec = `# Spec {#spec.top}

## Format {#spec.format}

- Context: \`prd.goal\`, \`prd.viewer\`

Prose that says \`<!-- human -->\` in a code span.

### Child {#spec.format.child}

- Implements: \`prd.section-ids\`
- Files: \`packages/core/src/\`, \`a.ts\`
- Depends on: \`spec.sections.parsing\`, \`prd.goal\`
- Defers: \`prd.viewer\`, \`not an id\`

<!-- human -->

## Next {#spec.next}
`;

it("reads a spec section as spec.format describes it", () => {
  const [top, format, child, next] = sectionsOf(spec);
  expect(top).toMatchObject({ id: "spec.top", level: 1, line: 1, parent: undefined });
  expect(format).toMatchObject({ human: false, line: 3, parent: "spec.top" });
  expect(format?.keys.context).toEqual(["prd.goal", "prd.viewer"]);
  expect(child).toMatchObject({ human: true, line: 9, parent: "spec.format", title: "Child" });
  expect(child?.keys).toEqual({
    context: ["prd.goal", "prd.viewer"],
    defers: ["prd.viewer"],
    dependsOn: ["spec.sections.parsing"],
    files: ["packages/core/src/", "a.ts"],
    implements: ["prd.section-ids"],
  });
  expect(next).toMatchObject({ human: false, parent: "spec.top" });
  expect(next?.keys.context).toEqual([]);
});

it("a blank line between key items does not end the key list", () => {
  const [section] = sectionsOf(
    "## One {#spec.one}\n\n- Implements: `prd.goal`\n\n- Files: `a.ts`\n\nProse.\n\n- Files: `late.ts`",
  );
  expect(section?.keys).toMatchObject({ files: ["a.ts"], implements: ["prd.goal"] });
});

it("a heading with no id or a malformed id has no id", () => {
  expect(
    Array.map(sectionsOf("## One\n## Two {#oops}\n## Three {#prd.three}"), ({ id }) => id),
  ).toEqual([undefined, undefined, "prd.three"]);
});

it("a document with no heading has no section", () => {
  expect(sectionsOf("")).toEqual([]);
  expect(sectionsOf("prose\n```\n# not a heading\n")).toEqual([]);
});

const Ticks = Schema.Literals([1, 2, 3]);

/** What looks like a marker and is not one: the marker quoted in a code span, a fence or indented code, or other HTML. */
const Decoy = Schema.TaggedUnion({
  fenced: { fence: Schema.Literals(["```", "~~~", "````"]) },
  indented: {},
  inline: { ticks: Ticks },
  other: { html: Schema.Literals(["<!-- note -->", "<!-- humans -->", "<br>"]) },
  spanning: { ticks: Ticks },
});

const decoyLines = Decoy.match({
  fenced: ({ fence }) => [fence, MARKER, fence],
  indented: () => [`    ${MARKER}`],
  inline: ({ ticks }) => {
    const run = String.repeat(ticks)("`");
    return [`before ${run} ${MARKER} ${run} after`];
  },
  other: ({ html }) => [html],
  spanning: ({ ticks }) => {
    const run = String.repeat(ticks)("`");
    return [`before ${run} code`, `and ${MARKER} ${run} after`];
  },
});

/** Each block sits between blank lines, so none runs into the next. */
const blocksOf = (blocks: readonly (readonly string[])[]): readonly string[] =>
  Array.flatMap(blocks, (lines) => Array.flatten([[""], lines, [""]]));

const Bare = Schema.Literals(["block", "inline"]);

const bareLines = (bare: typeof Bare.Type): readonly string[] =>
  bare === "block" ? [MARKER] : [`Needs approval. ${MARKER}`];

it.prop(
  "a marker in a code span of any length, a fence or indented code, and other HTML, is never a tag",
  { decoys: Schema.NonEmptyArray(Decoy) },
  ({ decoys }) => {
    const markdown = Array.join(
      Array.flatten([
        ["## One {#spec.one}"],
        blocksOf(Array.map(decoys, decoyLines)),
        ["### Two {#spec.two}"],
      ]),
      "\n",
    );
    expect(Array.map(sectionsOf(markdown), ({ human }) => human)).toEqual([false, false]);
  },
);

it.prop(
  "a bare marker is a tag, whatever else surrounds it, and it reaches the sections below",
  { after: Schema.Array(Decoy), bare: Bare, before: Schema.Array(Decoy) },
  ({ after, bare, before }) => {
    const markdown = Array.join(
      Array.flatten([
        ["## Zero {#spec.zero}", "## One {#spec.one}"],
        blocksOf(Array.map(before, decoyLines)),
        bareLines(bare),
        blocksOf(Array.map(after, decoyLines)),
        ["### Two {#spec.two}"],
      ]),
      "\n",
    );
    expect(Array.map(sectionsOf(markdown), ({ human }) => human)).toEqual([false, true, true]);
  },
);

it("a marker followed by text on its line is a tag", () => {
  expect(
    Array.map(sectionsOf("## One\n\n<!-- human --> Needs approval\n"), ({ human }) => human),
  ).toEqual([true]);
});

it("a marker inside an HTML block belongs to the section its own line is in", () => {
  const sections = sectionsOf(
    "## One {#spec.one}\n\n<div>\n## Two {#spec.two}\n<!-- human -->\n</div>\n",
  );
  expect(Array.map(sections, ({ human }) => human)).toEqual([false, true]);
});
