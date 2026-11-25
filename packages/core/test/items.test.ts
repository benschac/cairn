import { SECTION_ID } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, HashSet, Option, Schema, String, pipe } from "effect";

import { assignItemIds, itemsOf, sectionIdsOf, sectionsOf } from "../src/index.ts";

const Words = Schema.Literals([
  "Save the current filters",
  "`cairn lint` checks every task",
  "[Section IDs](#prd.section-ids) rules",
  "!!!",
  "**Bold** and _plain_ words",
  "Café menu",
  "One",
]);

const Line = Schema.TaggedUnion({
  blank: {},
  continuation: { text: Words },
  doneWhen: {},
  fence: {},
  heading: {
    id: Schema.Literals(["prd.saved-views", "prd.cli", "prd.api"]),
    level: Schema.Literals([1, 2, 3]),
  },
  item: {
    indent: Schema.Literals([0, 2, 4]),
    marker: Schema.Literals(["-", "*", "1."]),
    tail: Schema.Literals(["none", "ask", "id"]),
    text: Words,
  },
  prose: { text: Words },
});

const TAILS = { ask: " {#}", id: " {#prd.cli.taken}", none: "" } as const;

const renderLine = Line.match({
  blank: () => "",
  continuation: ({ text }) => `    ${text}`,
  doneWhen: () => "Done when:",
  fence: () => "```",
  heading: ({ id, level }) => `${String.repeat(level)("#")} Title {#${id}}`,
  item: ({ indent, marker, tail, text }) =>
    `${String.repeat(indent)(" ")}${marker} ${text}${TAILS[tail]}`,
  prose: ({ text }) => text,
});

const render = (lines: readonly (typeof Line.Type)[]) =>
  Array.join(Array.map(lines, renderLine), "\n");

const Document = { lines: Schema.Array(Line) };

const asking = (line: string) => String.endsWith("{#}")(line);

it.prop("assigning item IDs twice changes nothing the second time", Document, ({ lines }) => {
  const once = assignItemIds(render(lines));
  const twice = assignItemIds(once.markdown);
  expect(twice.markdown).toBe(once.markdown);
  expect(twice.added).toEqual([]);
});

it.prop("only lines that end in {#} change, and only by an ID", Document, ({ lines }) => {
  const before = String.split(render(lines), "\n");
  const after = String.split(assignItemIds(render(lines)).markdown, "\n");
  expect(after).toHaveLength(before.length);
  Array.forEach(Array.zip(before, after), ([line, written]) => {
    if (!asking(line)) {
      expect(written).toBe(line);
    } else if (written !== line) {
      const asked = pipe(line, String.slice(0, -1));
      expect(String.startsWith(asked)(written)).toBe(true);
      expect(String.slice(String.length(asked))(written)).toMatch(/^prd\.[a-z0-9.-]+\}$/u);
    }
  });
});

it.prop("every new item ID is well formed, new and added once", Document, ({ lines }) => {
  const markdown = render(lines);
  const existing = HashSet.fromIterable(
    Array.appendAll(
      sectionIdsOf(markdown),
      Array.getSomes(
        Array.map(itemsOf(markdown, sectionsOf(markdown)), (item) =>
          Option.fromUndefinedOr(item.id),
        ),
      ),
    ),
  );
  const { added } = assignItemIds(markdown);
  expect(Array.dedupe(added)).toStrictEqual(added);
  Array.forEach(added, (id) => {
    expect(id).toMatch(SECTION_ID);
    expect(HashSet.has(existing, id)).toBe(false);
  });
});

it.prop("every item's parent is a heading or an item that comes earlier", Document, ({ lines }) => {
  const markdown = render(lines);
  const sections = sectionsOf(markdown);
  const items = itemsOf(markdown, sections);
  Array.forEach(items, (item) => {
    if (item.parent !== undefined) {
      const places: ReadonlyArray<ReadonlyArray<Place>> = [sections, items];
      const earlier = Array.flatMapNullishOr(Array.flatten(places), (other) =>
        other.line < item.line ? other.id : undefined,
      );
      expect(Array.contains(earlier, item.parent)).toBe(true);
    }
  });
});

it.prop("items inside a fence are ignored", Document, ({ lines }) => {
  const markdown = render(Array.filter(lines, (line) => !Line.guards.fence(line)));
  const fenced = `\`\`\`\n${markdown}\n\`\`\``;
  expect(itemsOf(fenced, sectionsOf(fenced))).toEqual([]);
  expect(assignItemIds(fenced)).toEqual({ added: [], markdown: fenced, unplaced: [] });
});

interface Place {
  readonly id: string | undefined;
  readonly line: number;
}

const doc = (...lines: readonly string[]) => Array.join(lines, "\n");
const read = (markdown: string) => itemsOf(markdown, sectionsOf(markdown));

it("an item nested two deep names the item above it as its parent", () => {
  const items = read(
    doc(
      "## Saved views {#prd.saved-views}",
      "",
      "- Top {#prd.saved-views.top}",
      "  - Middle {#prd.saved-views.middle}",
      "    - Leaf {#prd.saved-views.leaf}",
      "  - Plain, with no ID",
      "    - Under plain",
      "- Next top {#prd.saved-views.next}",
    ),
  );
  expect(Array.map(items, (item) => [item.id, item.parent, item.section])).toEqual([
    ["prd.saved-views.top", "prd.saved-views", "prd.saved-views"],
    ["prd.saved-views.middle", "prd.saved-views.top", "prd.saved-views"],
    ["prd.saved-views.leaf", "prd.saved-views.middle", "prd.saved-views"],
    [undefined, "prd.saved-views.top", "prd.saved-views"],
    [undefined, "prd.saved-views.top", "prd.saved-views"],
    ["prd.saved-views.next", "prd.saved-views", "prd.saved-views"],
  ]);
});

it("an item whose text wraps onto three lines has its attribute read from the last line", () => {
  const markdown = doc(
    "## Saved views {#prd.saved-views}",
    "",
    "- Save the current filters",
    "  under a name so they come",
    "  back on reload. {#prd.saved-views.save}",
    "- Share a view",
    "  by link. {#}",
  );
  const items = read(markdown);
  expect(items).toEqual([
    expect.objectContaining({
      asks: false,
      id: "prd.saved-views.save",
      line: 3,
      text: "Save the current filters under a name so they come back on reload.",
    }),
    expect.objectContaining({ asks: true, id: undefined, line: 6, text: "Share a view by link." }),
  ]);
  expect(assignItemIds(markdown)).toEqual({
    added: ["prd.saved-views.share-a"],
    unplaced: [],
    markdown: doc(
      "## Saved views {#prd.saved-views}",
      "",
      "- Save the current filters",
      "  under a name so they come",
      "  back on reload. {#prd.saved-views.save}",
      "- Share a view",
      "  by link. {#prd.saved-views.share-a}",
    ),
  });
});

it("two items with the same first words under one heading get -2 and -3", () => {
  expect(
    assignItemIds(
      doc(
        "## CLI {#prd.cli}",
        "",
        "- `cairn lint` checks a task {#}",
        "- `cairn lint` warns about a statement {#}",
        "- Cairn lint again {#}",
        "- Other {#}",
        "- !!! {#}",
      ),
    ),
  ).toEqual({
    added: [
      "prd.cli.cairn-lint",
      "prd.cli.cairn-lint-2",
      "prd.cli.cairn-lint-3",
      "prd.cli.other",
      "prd.cli.item",
    ],
    unplaced: [],
    markdown: doc(
      "## CLI {#prd.cli}",
      "",
      "- `cairn lint` checks a task {#prd.cli.cairn-lint}",
      "- `cairn lint` warns about a statement {#prd.cli.cairn-lint-2}",
      "- Cairn lint again {#prd.cli.cairn-lint-3}",
      "- Other {#prd.cli.other}",
      "- !!! {#prd.cli.item}",
    ),
  });
});

it("a new ID avoids an ID that is taken in the document or outside it", () => {
  const markdown = doc(
    "## CLI {#prd.cli}",
    "",
    "- Lint {#prd.cli.lint}",
    "- Lint {#}",
    "- Plan {#}",
  );
  expect(assignItemIds(markdown, HashSet.make("prd.cli.plan")).added).toEqual([
    "prd.cli.lint-2",
    "prd.cli.plan-2",
  ]);
});

it("an item takes the ID of the heading it is under, whatever its nesting", () => {
  expect(
    assignItemIds(
      doc(
        "## A {#prd.a}",
        "",
        "- Top {#prd.a.top}",
        "  - Deep thing {#}",
        "### B {#prd.a.b}",
        "- Under b {#}",
      ),
    ).added,
  ).toEqual(["prd.a.deep-thing", "prd.a.b.under-b"]);
});

it("an item with no attribute or an ID is left alone, and one with no heading keeps its {#} and is reported", () => {
  const markdown = doc(
    "- Before any heading {#}",
    "## A {#prd.a}",
    "",
    "- Plain",
    "- Named {#prd.a.named}",
  );
  expect(assignItemIds(markdown)).toEqual({ added: [], markdown, unplaced: [1] });
  expect(Array.map(read(markdown), (item) => item.section)).toEqual([undefined, "prd.a", "prd.a"]);
});

it("the items of a Done when list are statements, not items", () => {
  const markdown = doc(
    "## Saved views {#prd.saved-views}",
    "",
    "- Before {#}",
    "",
    "Done when:",
    "",
    "- Saving shows the name. {#}",
    "  - A detail of that statement",
    "- Reloading keeps it.",
    "",
    "Paragraph.",
    "",
    "- After the list {#}",
    "",
    "Other paragraph.",
    "",
    "- Another list",
  );
  expect(Array.map(read(markdown), (item) => item.text)).toEqual([
    "Before",
    "After the list",
    "Another list",
  ]);
  expect(assignItemIds(markdown).markdown).toBe(
    pipe(
      markdown,
      String.replace("- Before {#}", "- Before {#prd.saved-views.before}"),
      String.replace("- After the list {#}", "- After the list {#prd.saved-views.after-the}"),
    ),
  );
});

it("a Done when line nested under an item leaves the item's own text before it", () => {
  const items = read(
    doc(
      "## Saved views {#prd.saved-views}",
      "",
      "- Save a view. {#prd.saved-views.save}",
      "  Done when:",
      "",
      "  - Saving shows the name.",
      "- Share a view. {#prd.saved-views.share}",
    ),
  );
  expect(Array.map(items, (item) => [item.id, item.text])).toEqual([
    ["prd.saved-views.save", "Save a view."],
    ["prd.saved-views.share", "Share a view."],
  ]);
});

it("a paragraph that only starts with Done when does not hide the list after it", () => {
  const items = read(doc("## A {#prd.a}", "", "Done when it works:", "", "- Kept {#prd.a.kept}"));
  expect(Array.map(items, (item) => item.id)).toEqual(["prd.a.kept"]);
});

it("an item is human by its own marker, its section or an item it is nested in", () => {
  const markdown = doc(
    "- Before any heading <!-- human -->",
    "- Also before any heading",
    "",
    "## Plain {#prd.plain}",
    "",
    "- Plain {#prd.plain.plain}",
    "",
    "## Marked {#prd.marked}",
    "",
    "- Marked <!-- human --> {#prd.marked.marked}",
    "  - Child of marked {#prd.marked.child}",
    "",
    "## Quoted {#prd.quoted}",
    "",
    "- Quoted `<!-- human -->` {#prd.quoted.quoted}",
    "",
    "## Gated {#prd.gated}",
    "",
    "<!-- human -->",
    "",
    "- Whole section {#prd.gated.whole}",
  );
  expect(Array.map(read(markdown), (item) => item.human)).toEqual([
    true,
    false,
    false,
    true,
    true,
    false,
    true,
  ]);
});

it("an item marked human makes its nested items human but not its siblings, without a section", () => {
  const items = itemsOf(doc("- Marked <!-- human -->", "  - Child", "- Sibling"), []);
  expect(Array.map(items, (item) => item.human)).toEqual([true, true, false]);
});

it("a marker in one item's text makes its section human, so the items beside it are human too", () => {
  const items = read(
    doc("## A {#prd.a}", "", "- Marked <!-- human --> {#prd.a.marked}", "- Beside {#prd.a.beside}"),
  );
  expect(Array.map(items, (item) => item.human)).toEqual([true, true]);
});

it("an attribute that is not a section ID is stripped from the text and gives no ID", () => {
  expect(read(doc("## A {#prd.a}", "", "- Odd {#Not An Id}", "- Spec {#spec.a.b}"))).toEqual([
    expect.objectContaining({ asks: false, id: undefined, text: "Odd {#Not An Id}" }),
    expect.objectContaining({ asks: false, id: "spec.a.b", text: "Spec" }),
  ]);
});
