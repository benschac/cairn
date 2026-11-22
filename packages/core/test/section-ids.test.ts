import { SECTION_ID, SectionPrefix } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Schema, String } from "effect";

import { assignSectionIds, sectionIdsOf } from "../src/index.ts";

const Words = Schema.Literals([
  "Saved views",
  "Persist filter state",
  "API",
  "Schéma & données",
  "!!!",
  "2 phases",
]);

const Line = Schema.TaggedUnion({
  fence: {},
  heading: { level: Schema.Literals([1, 2, 3, 4]), text: Words },
  identified: {
    id: Schema.Literals(["prd.saved-views", "spec.saved-views.persist", "prd.api"]),
    level: Schema.Literals([2, 3]),
    text: Words,
  },
  prose: { text: Words },
});

const renderLine = Line.match({
  fence: () => "```",
  heading: ({ level, text }) => `${String.repeat(level)("#")} ${text}`,
  identified: ({ id, level, text }) => `${String.repeat(level)("#")} ${text} {#${id}}`,
  prose: ({ text }) => `${text} # not a heading`,
});

const render = (lines: readonly (typeof Line.Type)[]) =>
  Array.join(Array.map(lines, renderLine), "\n");

const Document = { lines: Schema.Array(Line), prefix: SectionPrefix };

it.prop("assigning IDs twice changes nothing the second time", Document, ({ lines, prefix }) => {
  const once = assignSectionIds(render(lines), prefix);
  const twice = assignSectionIds(once.markdown, prefix);
  expect(twice.markdown).toBe(once.markdown);
  expect(twice.added).toEqual([]);
});

it.prop("existing IDs and every other line are left as written", Document, ({ lines, prefix }) => {
  const before = String.split(render(lines), "\n");
  const after = String.split(assignSectionIds(render(lines), prefix).markdown, "\n");
  expect(after).toHaveLength(before.length);
  for (const [index, line] of before.entries()) {
    const isBareHeading = Line.guards.heading(lines[index]);
    if (!isBareHeading) {
      expect(after[index]).toBe(line);
    } else if (after[index] !== line) {
      expect(after[index]?.startsWith(`${line} {#`)).toBe(true);
    }
  }
});

it.prop("every new ID is well formed and no ID is added twice", Document, ({ lines, prefix }) => {
  const { added, markdown } = assignSectionIds(render(lines), prefix);
  for (const id of added) {
    expect(id).toMatch(SECTION_ID);
  }
  expect(Array.dedupe(added)).toStrictEqual(added);
  for (const id of added) {
    expect(Array.filter(sectionIdsOf(markdown), (existing) => existing === id)).toHaveLength(1);
  }
});

it("a section takes its parent section's ID as its namespace", () => {
  const { markdown } = assignSectionIds(
    ["# Plan", "## Saved views", "### Persist filter state", "## Saved views"].join("\n"),
    "spec",
  );
  expect(String.split(markdown, "\n")).toEqual([
    "# Plan {#spec.plan}",
    "## Saved views {#spec.saved-views}",
    "### Persist filter state {#spec.saved-views.persist-filter-state}",
    "## Saved views {#spec.saved-views-2}",
  ]);
});
