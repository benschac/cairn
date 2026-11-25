import { PrdSectionId, StatementId, ownerOf } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, String, pipe } from "effect";

import { itemsOf, sectionsOf, settle, statementsOf, withDrafts } from "../src/index.ts";
import type { DraftAnswer, Drafted } from "../src/index.ts";

const Words = Schema.Literals([
  "Saving the filters shows the name",
  "`cairn lint` warns on a draft",
  "[Section IDs](#prd.section-ids) read well",
  "Café menu",
  "One",
]);

/** A section with prose, a list of items (some with a nested one) and maybe a statement already. */
const Part = Schema.Struct({
  existing: Schema.Boolean,
  gap: Schema.Boolean,
  items: Schema.Array(Schema.Struct({ nested: Schema.Boolean, text: Words })).check(
    Schema.isMaxLength(3),
  ),
  level: Schema.Literals([2, 3]),
  prose: Schema.Array(Words).check(Schema.isMaxLength(2)),
});

const Input = {
  drafts: Schema.Array(Words).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  parts: Schema.Array(Part).check(Schema.isMaxLength(2)),
  trailing: Schema.Boolean,
};

const decodeId = Schema.decodeUnknownSync(PrdSectionId);

/** The document, and every section and item ID in it. */
const documentOf = ({
  parts,
  trailing,
}: {
  readonly parts: readonly (typeof Part.Type)[];
  readonly trailing: boolean;
}) => {
  const rendered = Array.map(parts, (part, index) => {
    const id = `prd.s${index}`;
    const lines = Array.flatten([
      [`${pipe("#", String.repeat(part.level))} Title ${index} {#${id}}`, ""],
      Array.map(part.prose, (text) => `${text}\n`),
      Array.flatMap(part.items, ({ nested, text }, at) =>
        Array.flatten([[`- ${text} {#${id}.i${at}}`], nested ? ["  - A nested detail"] : []]),
      ),
      part.existing ? ["", "Done when:", "", `- Confirmed. {#${id}#v3}`] : [],
      part.gap ? [""] : [],
    ]);
    return {
      ids: Array.prepend(
        Array.map(part.items, (_, at) => decodeId(`${id}.i${at}`)),
        decodeId(id),
      ),
      lines,
    };
  });
  return {
    ids: Array.flatMap(rendered, ({ ids }) => ids),
    markdown: Array.join(
      Array.appendAll(
        Array.flatMap(rendered, ({ lines }) => lines),
        trailing ? [""] : [],
      ),
      "\n",
    ),
  };
};

const read = (markdown: string) => {
  const sections = sectionsOf(markdown);
  return statementsOf(markdown, sections, itemsOf(markdown, sections));
};

const draftsFor = (ids: readonly PrdSectionId[], drafts: readonly string[]): readonly Drafted[] =>
  Array.map(ids, (target) => ({ drafts, target }));

/** `markdown` without the lines at the 0-based `inserted` positions. */
const withoutInserted = (markdown: string, inserted: readonly number[]) =>
  pipe(
    String.split(markdown, "\n"),
    Array.filter((_, index) => !Array.contains(inserted, index)),
    Array.join("\n"),
  );

it.prop(
  "removing the inserted lines gives back the original text byte for byte",
  Input,
  (input) => {
    const { ids, markdown } = documentOf(input);
    const result = withDrafts(markdown, draftsFor(ids, input.drafts));
    expect(withoutInserted(result.markdown, result.inserted)).toBe(markdown);
  },
);

it.prop(
  "every draft becomes a Draft statement under its target, numbered above the target's others",
  Input,
  (input) => {
    const { ids, markdown } = documentOf(input);
    const before = read(markdown);
    const result = withDrafts(markdown, draftsFor(ids, input.drafts));
    const after = read(result.markdown);
    const fresh = Array.filter(after, ({ id }) => Array.contains(result.added, id));
    expect(Array.length(result.added)).toBe(Array.length(ids) * Array.length(input.drafts));
    expect(Array.dedupe(result.added)).toStrictEqual(result.added);
    expect(Array.length(after)).toBe(Array.length(before) + Array.length(result.added));
    expect(Array.length(fresh)).toBe(Array.length(result.added));
    Array.forEach(fresh, ({ draft, human, owner, id }) => {
      expect(draft).toBe(true);
      expect(human).toBe(false);
      expect(Option.fromUndefinedOr(id).pipe(Option.map(ownerOf))).toEqual(Option.some(owner));
    });
    Array.forEach(ids, (target) => {
      const own = Array.filter(fresh, ({ owner }) => owner === target);
      expect(Array.map(own, ({ text }) => text)).toEqual(
        Array.map(input.drafts, (text) => `Draft: ${text}`),
      );
    });
    // The existing statement is `v3`, so a section that has one gets `v4` and up.
    Array.forEach(
      Array.filter(fresh, ({ id }) => id !== undefined && String.endsWith("#v4")(id)),
      ({ owner }) => {
        expect(Array.some(before, (old) => old.owner === owner)).toBe(true);
      },
    );
  },
);

it.prop("deleting every inserted draft gives back the original text", Input, (input) => {
  const { ids, markdown } = documentOf(input);
  const { added, markdown: drafted } = withDrafts(markdown, draftsFor(ids, input.drafts));
  const emptied = Array.reduce(added, drafted, (text, id) => settle(text, id, { _tag: "delete" }));
  expect(emptied).toBe(markdown);
});

it.prop("a draft deleted from a list of several leaves the others as they were", Input, (input) => {
  const { ids, markdown } = documentOf(input);
  const { added, markdown: drafted } = withDrafts(markdown, draftsFor(ids, input.drafts));
  Array.forEach(sampled(added), (id) => {
    const left = read(settle(drafted, id, { _tag: "delete" }));
    expect(Array.map(left, (statement) => statement.id)).toEqual(
      Array.filter(
        Array.map(read(drafted), (statement) => statement.id),
        (other) => other !== id,
      ),
    );
  });
});

/** One of `ids`, the last: settling each one parses the whole document again. */
const sampled = (ids: readonly StatementId[]) => Array.getSomes([Array.last(ids)]);

const undrafted = (markdown: string, id: StatementId, answer: DraftAnswer) =>
  read(settle(markdown, id, answer));

it.prop("accept removes Draft: and changes nothing else", Input, (input) => {
  const { ids, markdown } = documentOf(input);
  const { added, markdown: drafted } = withDrafts(markdown, draftsFor(ids, input.drafts));
  Array.forEach(sampled(added), (id) => {
    const before = read(drafted);
    const after = undrafted(drafted, id, { _tag: "accept" });
    expect(Array.map(after, ({ draft, id: found, text }) => [draft, found, text])).toEqual(
      Array.map(before, ({ draft, id: found, text }) =>
        found === id ? [false, found, String.replace(/^Draft: /u, "")(text)] : [draft, found, text],
      ),
    );
    // A confirmed statement is not touched again.
    const once = settle(drafted, id, { _tag: "accept" });
    expect(settle(once, id, { _tag: "accept" })).toBe(once);
  });
});

it.prop("rewrite keeps the ID, confirms the statement and changes nothing else", Input, (input) => {
  const { ids, markdown } = documentOf(input);
  const { added, markdown: drafted } = withDrafts(markdown, draftsFor(ids, input.drafts));
  Array.forEach(sampled(added), (id) => {
    const before = read(drafted);
    const after = undrafted(drafted, id, { _tag: "rewrite", text: "  My own\twords. " });
    expect(
      Array.map(after, ({ draft, id: found, owner, text }) => [draft, found, owner, text]),
    ).toEqual(
      Array.map(before, ({ draft, id: found, owner, text }) =>
        found === id ? [false, found, owner, "My own words."] : [draft, found, owner, text],
      ),
    );
  });
});

it.prop("skip, an empty rewrite and an unknown ID change nothing", Input, (input) => {
  const { ids, markdown } = documentOf(input);
  const { added, markdown: drafted } = withDrafts(markdown, draftsFor(ids, input.drafts));
  Array.forEach(sampled(added), (id) => {
    expect(settle(drafted, id, { _tag: "skip" })).toBe(drafted);
    expect(settle(drafted, id, { _tag: "rewrite", text: " \n " })).toBe(drafted);
  });
  const unknown = Schema.decodeSync(StatementId)("prd.nowhere#v1");
  expect(settle(drafted, unknown, { _tag: "delete" })).toBe(drafted);
});

const doc = (...lines: readonly string[]) => Array.join(lines, "\n");

it("a section's list goes at the end of its own body, before its first child heading", () => {
  const markdown = doc(
    "## A {#prd.a}",
    "",
    "Some words.",
    "",
    "### B {#prd.a.b}",
    "",
    "More words.",
    "",
  );
  expect(
    withDrafts(markdown, [
      { drafts: ["One thing happens.", "Draft: Another {#prd.zzz#v9}"], target: decodeId("prd.a") },
      { drafts: ["Nothing", " "], target: decodeId("prd.a.b") },
    ]),
  ).toEqual({
    added: ["prd.a#v1", "prd.a#v2", "prd.a.b#v1"],
    inserted: [3, 4, 5, 6, 7, 12, 13, 14, 15],
    markdown: doc(
      "## A {#prd.a}",
      "",
      "Some words.",
      "",
      "Done when:",
      "",
      "- Draft: One thing happens. {#prd.a#v1}",
      "- Draft: Another {#prd.a#v2}",
      "",
      "### B {#prd.a.b}",
      "",
      "More words.",
      "",
      "Done when:",
      "",
      "- Draft: Nothing {#prd.a.b#v1}",
      "",
    ),
  });
});

it("an item's list is indented under it, after its nested items, and a section's follows", () => {
  const markdown = doc(
    "## A {#prd.a}",
    "",
    "- First",
    "  wraps {#prd.a.first}",
    "  - Nested one",
    "",
    "- Second {#prd.a.second}",
  );
  expect(
    withDrafts(markdown, [
      { drafts: ["For a section."], target: decodeId("prd.a") },
      { drafts: ["For the first."], target: decodeId("prd.a.first") },
      { drafts: ["For the second."], target: decodeId("prd.a.second") },
    ]).markdown,
  ).toBe(
    doc(
      "## A {#prd.a}",
      "",
      "- First",
      "  wraps {#prd.a.first}",
      "  - Nested one",
      "",
      "  Done when:",
      "",
      "  - Draft: For the first. {#prd.a.first#v1}",
      "",
      "- Second {#prd.a.second}",
      "",
      "  Done when:",
      "",
      "  - Draft: For the second. {#prd.a.second#v1}",
      "",
      "Done when:",
      "",
      "- Draft: For a section. {#prd.a#v1}",
    ),
  );
});

it("drafts for the first item are read as that item's, and not as a statement of its nested item", () => {
  const markdown = doc("## A {#prd.a}", "", "- First {#prd.a.first}", "  - Nested one");
  const { markdown: drafted } = withDrafts(markdown, [
    { drafts: ["For the first."], target: decodeId("prd.a.first") },
  ]);
  expect(Array.map(read(drafted), ({ owner, text }) => [owner, text])).toEqual([
    ["prd.a.first", "Draft: For the first."],
  ]);
  expect(Array.length(itemsOf(drafted, sectionsOf(drafted)))).toBe(2);
});

it("a target that is no section or item with an ID gets nothing", () => {
  const markdown = doc("## A {#prd.a}", "", "- No ID", "");
  expect(withDrafts(markdown, [{ drafts: ["Nope."], target: decodeId("prd.b") }])).toEqual({
    added: [],
    inserted: [],
    markdown,
  });
});

it("deleting one of two drafts keeps the list, and deleting the last takes the Done when line too", () => {
  const markdown = doc(
    "## A {#prd.a}",
    "",
    "Words.",
    "",
    "Done when:",
    "",
    "- Draft: One. {#prd.a#v1}",
    "- Draft: Two. {#prd.a#v2}",
    "",
    "## B {#prd.b}",
  );
  const first = settle(markdown, Schema.decodeSync(StatementId)("prd.a#v1"), { _tag: "delete" });
  expect(first).toBe(
    doc(
      "## A {#prd.a}",
      "",
      "Words.",
      "",
      "Done when:",
      "",
      "- Draft: Two. {#prd.a#v2}",
      "",
      "## B {#prd.b}",
    ),
  );
  expect(settle(first, Schema.decodeSync(StatementId)("prd.a#v2"), { _tag: "delete" })).toBe(
    doc("## A {#prd.a}", "", "Words.", "", "## B {#prd.b}"),
  );
});
