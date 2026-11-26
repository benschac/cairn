import { IndexedSection, ManifestTask, SpecSectionId, ownerOf } from "@cairn/contract";
import type { StatementId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Number, Option, Record, Result, Schema, String, Struct, pipe } from "effect";

import {
  assignStatementIds,
  itemsOf,
  lint,
  sectionsOf,
  statementsOf,
  taskStatementsOf,
} from "../src/index.ts";

const Words = Schema.Literals([
  "Saving the filters shows the name",
  "`cairn lint` warns on a draft",
  "[Section IDs](#prd.section-ids) read well",
  "**Bold** and _plain_ words",
  "Café menu",
  "One",
]);

const Line = Schema.TaggedUnion({
  blank: {},
  doneWhen: { indent: Schema.Literals([0, 2]) },
  fence: {},
  heading: {
    id: Schema.Literals(["prd.saved-views", "prd.cli", "prd.api"]),
    level: Schema.Literals([1, 2, 3]),
  },
  item: { indent: Schema.Literals([0, 2]), text: Words },
  prose: { text: Words },
  statement: {
    draft: Schema.Boolean,
    indent: Schema.Literals([0, 2]),
    tail: Schema.Literals(["none", "ask", "v1", "v3", "v9", "api-v2", "foreign"]),
    text: Words,
  },
});

const TAILS = {
  "api-v2": " {#prd.api#v2}",
  ask: " {#}",
  foreign: " {#prd.elsewhere#v4}",
  none: "",
  v1: " {#prd.cli#v1}",
  v3: " {#prd.saved-views#v3}",
  v9: " {#prd.cli#v9}",
} as const;

const renderLine = Line.match({
  blank: () => "",
  doneWhen: ({ indent }) => `${String.repeat(indent)(" ")}Done when:`,
  fence: () => "```",
  heading: ({ id, level }) => `${String.repeat(level)("#")} Title {#${id}}`,
  item: ({ indent, text }) => `${String.repeat(indent)(" ")}- ${text}`,
  prose: ({ text }) => text,
  statement: ({ draft, indent, tail, text }) =>
    `${String.repeat(indent)(" ")}- ${draft ? "Draft: " : ""}${text}${TAILS[tail]}`,
});

const render = (lines: readonly (typeof Line.Type)[]) =>
  Array.join(Array.map(lines, renderLine), "\n");

/** Sections that each hold one statement list, so numbering has something to number. */
const Section = Schema.Struct({
  id: Schema.Literals(["prd.cli", "prd.api", "prd.saved-views"]),
  statements: Schema.Array(
    Schema.Struct({
      draft: Schema.Boolean,
      tail: Schema.Literals(["none", "ask", "v1", "v3", "v9", "api-v2", "foreign"]),
      text: Words,
    }),
  ),
});

const Document = {
  lines: Schema.Array(Line).check(Schema.isMaxLength(12)),
  sections: Schema.Array(Section).check(Schema.isMaxLength(4)),
};

/** The sections, then the loose lines, so that a fence among them cannot swallow the sections. */
const documentOf = ({
  lines,
  sections,
}: {
  readonly lines: readonly (typeof Line.Type)[];
  readonly sections: readonly (typeof Section.Type)[];
}) =>
  Array.join(
    Array.appendAll(
      Array.flatMap(sections, ({ id, statements }) =>
        Array.flatten([
          [`## Title {#${id}}`, "", "Done when:", ""],
          Array.map(
            statements,
            ({ draft, tail, text }) => `- ${draft ? "Draft: " : ""}${text}${TAILS[tail]}`,
          ),
          [""],
        ]),
      ),
      Array.map(lines, renderLine),
    ),
    "\n",
  );

const read = (markdown: string) => {
  const sections = sectionsOf(markdown);
  return statementsOf(markdown, sections, itemsOf(markdown, sections));
};

const versionOf = (id: string) =>
  pipe(
    String.match(/#v(\d+)$/u)(id),
    Option.flatMap(Array.get(1)),
    Option.flatMap(Number.parse),
    Option.getOrElse(() => 0),
  );

/** The highest number each owner's IDs use. */
const highestOf = (ids: readonly StatementId[]) =>
  Array.reduce(ids, Record.empty<string, number>(), (found, id) => {
    const owner = ownerOf(id);
    return Record.set(
      found,
      owner,
      Number.max(Record.get(found, owner).pipe(Option.getOrElse(() => 0)), versionOf(id)),
    );
  });

const idsOf = (statements: ReturnType<typeof read>) =>
  Array.getSomes(Array.map(statements, ({ id }) => Option.fromUndefinedOr(id)));

it.prop(
  "numbering never changes an existing ID, a statement's text or where it is",
  Document,
  (input) => {
    const markdown = documentOf(input);
    const before = read(markdown);
    const after = read(assignStatementIds(markdown, before).markdown);
    expect(Array.map(after, ({ line, owner, text }) => [line, owner, text])).toEqual(
      Array.map(before, ({ line, owner, text }) => [line, owner, text]),
    );
    Array.forEach(Array.zip(before, after), ([old, now]) => {
      if (old.id !== undefined) {
        expect(now.id).toBe(old.id);
      }
    });
  },
);

it.prop(
  "a new ID's number is above every number its owner had, and no number repeats",
  Document,
  (input) => {
    const markdown = documentOf(input);
    const statements = read(markdown);
    const highest = highestOf(idsOf(statements));
    const { added } = assignStatementIds(markdown, statements);
    expect(added).toHaveLength(
      Array.length(Array.filter(statements, ({ id }) => id === undefined)),
    );
    expect(Array.dedupe(added)).toStrictEqual(added);
    Array.forEach(added, (id) => {
      expect(versionOf(id)).toBeGreaterThan(
        Option.getOrElse(Record.get(highest, ownerOf(id)), () => 0),
      );
    });
  },
);

it.prop(
  "after numbering every statement has an ID and numbering again changes nothing",
  Document,
  (input) => {
    const markdown = documentOf(input);
    const once = assignStatementIds(markdown, read(markdown));
    const numbered = read(once.markdown);
    expect(Array.every(numbered, ({ id }) => id !== undefined)).toBe(true);
    expect(assignStatementIds(once.markdown, numbered)).toEqual({
      added: [],
      markdown: once.markdown,
    });
  },
);

it.prop("a statement list inside a fence is ignored", Document, ({ lines }) => {
  const fenced = `\`\`\`\n${render(Array.filter(lines, (line) => !Line.guards.fence(line)))}\n\`\`\``;
  expect(read(fenced)).toEqual([]);
  expect(assignStatementIds(fenced, [])).toEqual({ added: [], markdown: fenced });
});

const doc = (...lines: readonly string[]) => Array.join(lines, "\n");

it("drafts and confirmed statements are told apart, and a human tag is read", () => {
  const statements = read(
    doc(
      "## Saved views {#prd.saved-views}",
      "",
      "Done when:",
      "",
      "- Saving shows the name. {#prd.saved-views#v1}",
      "- Draft: Opening a shared link shows the tasks. {#prd.saved-views#v2}",
      "- The menu reads well at phone width. <!-- human --> {#prd.saved-views#v3}",
      "- draft: Lowercase is not a draft.",
      "- Draft:No space is not a draft.",
    ),
  );
  expect(
    Array.map(statements, ({ draft, human, id, line, owner }) => ({
      draft,
      human,
      id,
      line,
      owner,
    })),
  ).toEqual([
    { draft: false, human: false, id: "prd.saved-views#v1", line: 5, owner: "prd.saved-views" },
    { draft: true, human: false, id: "prd.saved-views#v2", line: 6, owner: "prd.saved-views" },
    { draft: false, human: true, id: "prd.saved-views#v3", line: 7, owner: "prd.saved-views" },
    { draft: false, human: false, id: undefined, line: 8, owner: "prd.saved-views" },
    { draft: false, human: false, id: undefined, line: 9, owner: "prd.saved-views" },
  ]);
  expect(statements[1]?.text).toBe("Draft: Opening a shared link shows the tasks.");
});

it("a human marker on a wrapped statement's later line belongs to that statement only", () => {
  const statements = read(
    doc(
      "## A {#prd.a}",
      "",
      "Done when:",
      "",
      "- First wraps",
      "  onto a marked line. <!-- human -->",
      "- Second is plain.",
    ),
  );
  expect(Array.map(statements, ({ human }) => human)).toEqual([true, false]);
});

it("a paragraph that only starts with Done when gives no statement", () => {
  expect(
    read(
      doc(
        "## A {#prd.a}",
        "",
        "Done when it works:",
        "",
        "- An ordinary item",
        "",
        "Done when, on this repo, the list shows. {#prd.a#v1}",
        "",
        "- Another item",
      ),
    ),
  ).toEqual([]);
});

it("a statement list under a nested item belongs to that item", () => {
  const statements = read(
    doc(
      "## Saved views {#prd.saved-views}",
      "",
      "- Save a view. {#prd.saved-views.save}",
      "  - Name it",
      "    Done when:",
      "    - Deep statement.",
      "",
      "  Done when:",
      "  - Item statement.",
      "- Share a view. {#prd.saved-views.share}",
      "",
      "Done when:",
      "- Section statement.",
    ),
  );
  expect(Array.map(statements, ({ owner, text }) => [owner, text])).toEqual([
    ["prd.saved-views.save", "Deep statement."],
    ["prd.saved-views.save", "Item statement."],
    ["prd.saved-views", "Section statement."],
  ]);
});

it("a list under an item with an ID belongs to it; the heading owns the rest, under any heading", () => {
  const markdown = doc(
    "## A {#prd.a}",
    "",
    "- Item {#prd.a.item}",
    "  Done when:",
    "",
    "  - Under the item.",
    "### B {#prd.a.b}",
    "",
    "Done when:",
    "",
    "- Under b.",
  );
  expect(Array.map(read(markdown), ({ owner }) => owner)).toEqual(["prd.a.item", "prd.a.b"]);
});

it("a statement under a heading with no ID is left out", () => {
  expect(read(doc("## A", "", "Done when:", "", "- No owner."))).toEqual([]);
});

it("a nested sublist belongs to its statement and a wrapped statement is one", () => {
  const markdown = doc(
    "## A {#prd.a}",
    "",
    "Done when:",
    "",
    "- First statement",
    "  that wraps. {#prd.a#v1}",
    "  - A detail of it",
    "- Second statement.",
  );
  expect(Array.map(read(markdown), ({ id, line, text }) => [id, line, text])).toEqual([
    ["prd.a#v1", 5, "First statement that wraps."],
    [undefined, 8, "Second statement."],
  ]);
});

it("numbering gives the next free number for each owner and never renumbers", () => {
  const markdown = doc(
    "## A {#prd.a}",
    "",
    "- Item {#prd.a.item}",
    "  Done when:",
    "  - Item statement. {#}",
    "",
    "Done when:",
    "",
    "- Old one. {#prd.a#v1}",
    "- Gap one. {#prd.a#v4}",
    "- New one.",
    "  wrapped",
    "- Another new one.",
    "",
    "## B {#prd.b}",
    "",
    "Done when:",
    "- First of b.",
  );
  expect(assignStatementIds(markdown, read(markdown))).toEqual({
    added: ["prd.a.item#v1", "prd.a#v5", "prd.a#v6", "prd.b#v1"],
    markdown: doc(
      "## A {#prd.a}",
      "",
      "- Item {#prd.a.item}",
      "  Done when:",
      "  - Item statement. {#prd.a.item#v1}",
      "",
      "Done when:",
      "",
      "- Old one. {#prd.a#v1}",
      "- Gap one. {#prd.a#v4}",
      "- New one.",
      "  wrapped {#prd.a#v5}",
      "- Another new one. {#prd.a#v6}",
      "",
      "## B {#prd.b}",
      "",
      "Done when:",
      "- First of b. {#prd.b#v1}",
    ),
  });
});

it("a statement copied from another section keeps its ID and stays out of the numbering", () => {
  const markdown = doc("## A {#prd.a}", "", "Done when:", "", "- Copied. {#prd.b#v7}", "- Mine.");
  expect(assignStatementIds(markdown, read(markdown)).added).toEqual(["prd.a#v1"]);
});

const config = { humanPaths: [] };
const SPEC = "# Spec {#spec.spec}\n";

it("lint reports a statement whose ID names another owner, as an error on its line", () => {
  const prd = doc(
    "# Title {#prd.title}",
    "",
    "## A {#prd.a}",
    "",
    "Done when:",
    "",
    "- Mine. {#prd.a#v1}",
    "- Copied. {#prd.b#v1}",
    "- Not numbered yet.",
  );
  const found = Array.filter(
    lint(prd, SPEC, Option.none(), config),
    ({ rule }) => rule === "statement-owner",
  );
  expect(Array.map(found, ({ file, line, severity }) => [file, line, severity])).toEqual([
    ["prd.md", Option.some(8), "error"],
  ]);
  expect(found[0]?.message).toContain("prd.b#v1");
});

it.prop(
  "lint finds a misplaced statement exactly when its ID's owner is not where it sits",
  Document,
  (input) => {
    const markdown = documentOf(input);
    const expected = Array.filter(
      read(markdown),
      ({ id, owner }) => id !== undefined && ownerOf(id) !== owner,
    );
    const found = Array.filter(
      lint(markdown, SPEC, Option.none(), config),
      ({ rule }) => rule === "statement-owner",
    );
    expect(Array.map(found, ({ line }) => line)).toEqual(
      Array.map(expected, ({ line }) => Option.some(line)),
    );
  },
);

const PRD_IDS = ["prd.cli", "prd.api", "prd.saved-views"] as const;
const SPEC_IDS = ["spec.a", "spec.b", "spec.c"] as const;
const PROVABLE = [
  "prd.cli#v1",
  "prd.cli#v2",
  "prd.api#v1",
  "prd.saved-views#v1",
  "prd.saved-views#v3",
  "prd.elsewhere#v4",
] as const;

const Tracing = {
  ...Document,
  prdSections: Schema.Array(Schema.Literals(PRD_IDS)).check(Schema.isMinLength(1)),
  specSections: Schema.Array(Schema.Literals(SPEC_IDS)).check(Schema.isMinLength(1)),
  tests: Schema.Array(
    Schema.Struct({
      proves: Schema.Array(Schema.Literals(PROVABLE)),
      section: Schema.Literals(SPEC_IDS),
    }),
  ),
};

const decodeIndex = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ id: SpecSectionId, tests: IndexedSection.fields.tests })),
);

/** An index of the three spec sections, each asking for the generated tests that name it, numbered from 1. */
const indexOf = (tests: ReadonlyArray<{ proves: readonly string[]; section: string }>) =>
  decodeIndex(
    Array.map(SPEC_IDS, (id) => ({
      id,
      tests: Array.map(
        Array.filter(tests, ({ section }) => section === id),
        ({ proves }, at) => ({ id: `${id}#t${at + 1}`, kind: "example", proves, text: "A test." }),
      ),
    })),
  );

const decodeTask = Schema.decodeUnknownSync(
  Schema.Struct(Struct.pick(ManifestTask.fields, ["prdSections", "specSections"])),
);

const taskOf = (prdSections: readonly string[], specSections: readonly string[]) =>
  decodeTask({ prdSections, specSections });

it.prop(
  "a task carries exactly the statements of its PRD sections, and each is proved only by tests of its spec sections",
  Tracing,
  ({ lines, prdSections, sections, specSections, tests }) => {
    const statements = read(documentOf({ lines, sections }));
    const index = indexOf(tests);
    const task = taskOf(prdSections, specSections);
    const carried = taskStatementsOf(task, statements, index);
    expect(Array.map(carried, ({ id }) => id)).toEqual(
      idsOf(Array.filter(statements, ({ owner }) => Array.some(prdSections, (id) => id === owner))),
    );
    Array.forEach(carried, ({ draft, id, provedBy }) => {
      expect(Array.some(statements, (found) => found.id === id && found.draft === draft)).toBe(
        true,
      );
      Array.forEach(provedBy, (test) => {
        expect(
          Option.exists(Array.head(String.split(test, "#t")), (own) =>
            Array.contains(specSections, own),
          ),
        ).toBe(true);
      });
      const expected = Array.flatMap(index, (section) =>
        Array.some(specSections, (named) => named === section.id)
          ? Array.filterMap(section.tests, (test) =>
              Array.contains(test.proves, id) ? Result.succeed(test.id) : Result.failVoid,
            )
          : [],
      );
      expect(provedBy).toEqual(expected);
    });
  },
);

it("a task that names a section does not carry the statements of the items under it", () => {
  const prd = doc(
    "# Title {#prd.title}",
    "",
    "## A {#prd.a}",
    "",
    "Done when:",
    "",
    "- The section works. {#prd.a#v1}",
    "",
    "Items:",
    "",
    "- An item. {#prd.a.item}",
    "",
    "  Done when:",
    "",
    "  - The item works. {#prd.a.item#v1}",
  );
  const index = decodeIndex([
    {
      id: "spec.s",
      tests: [
        { id: "spec.s#t1", kind: "example", proves: ["prd.a#v1"], text: "Section." },
        { id: "spec.s#t2", kind: "example", proves: ["prd.a.item#v1"], text: "Item." },
      ],
    },
    {
      id: "spec.other",
      tests: [{ id: "spec.other#t1", kind: "example", proves: ["prd.a#v1"], text: "Elsewhere." }],
    },
  ]);
  const statements = read(prd);
  expect(taskStatementsOf(taskOf(["prd.a"], ["spec.s"]), statements, index)).toEqual([
    { draft: false, id: "prd.a#v1", provedBy: ["spec.s#t1"] },
  ]);
  expect(
    taskStatementsOf(taskOf(["prd.a.item"], ["spec.s", "spec.other"]), statements, index),
  ).toEqual([{ draft: false, id: "prd.a.item#v1", provedBy: ["spec.s#t2"] }]);
  expect(taskStatementsOf(taskOf(["prd.title"], ["spec.s"]), statements, index)).toEqual([]);
});
