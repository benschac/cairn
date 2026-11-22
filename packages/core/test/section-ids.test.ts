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
  Array.forEach(Array.zip(before, after), ([line, written], index) => {
    const isBareHeading = Line.guards.heading(lines[index]);
    if (!isBareHeading) {
      expect(written).toBe(line);
    } else if (written !== line) {
      expect(String.startsWith(`${line} {#`)(written)).toBe(true);
    }
  });
});

it.prop("every new ID is well formed and no ID is added twice", Document, ({ lines, prefix }) => {
  const { added, markdown } = assignSectionIds(render(lines), prefix);
  Array.forEach(added, (id) => {
    expect(id).toMatch(SECTION_ID);
  });
  expect(Array.dedupe(added)).toStrictEqual(added);
  Array.forEach(added, (id) => {
    expect(Array.countBy(sectionIdsOf(markdown), (existing) => existing === id)).toBe(1);
  });
});

it("a section takes its parent section's ID as its namespace", () => {
  const { markdown } = assignSectionIds(
    Array.join(["# Plan", "## Saved views", "### Persist filter state", "## Saved views"], "\n"),
    "spec",
  );
  expect(String.split(markdown, "\n")).toEqual([
    "# Plan {#spec.plan}",
    "## Saved views {#spec.saved-views}",
    "### Persist filter state {#spec.saved-views.persist-filter-state}",
    "## Saved views {#spec.saved-views-2}",
  ]);
});
