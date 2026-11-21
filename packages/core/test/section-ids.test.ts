import { SECTION_ID, SectionPrefix } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { assignSectionIds, sectionIdsOf } from "../src/index.ts";

const Words = Schema.Literals([
  "Saved views",
  "Persist filter state",
  "API",
  "Schéma & données",
  "!!!",
  "2 phases",
]);

const Line = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("heading"),
    level: Schema.Literals([1, 2, 3, 4]),
    text: Words,
  }),
  Schema.Struct({
    id: Schema.Literals(["prd.saved-views", "spec.saved-views.persist", "prd.api"]),
    kind: Schema.Literal("identified"),
    level: Schema.Literals([2, 3]),
    text: Words,
  }),
  Schema.Struct({ kind: Schema.Literal("prose"), text: Words }),
  Schema.Struct({ kind: Schema.Literal("fence") }),
]);

const render = (lines: readonly (typeof Line.Type)[]) =>
  lines
    .map((line) => {
      switch (line.kind) {
        case "heading": {
          return `${"#".repeat(line.level)} ${line.text}`;
        }
        case "identified": {
          return `${"#".repeat(line.level)} ${line.text} {#${line.id}}`;
        }
        case "prose": {
          return `${line.text} # not a heading`;
        }
        default: {
          return "```";
        }
      }
    })
    .join("\n");

const Document = { lines: Schema.Array(Line), prefix: SectionPrefix };

it.prop("assigning IDs twice changes nothing the second time", Document, ({ lines, prefix }) => {
  const once = assignSectionIds(render(lines), prefix);
  const twice = assignSectionIds(once.markdown, prefix);
  expect(twice.markdown).toBe(once.markdown);
  expect(twice.added).toEqual([]);
});

it.prop("existing IDs and every other line are left as written", Document, ({ lines, prefix }) => {
  const before = render(lines).split("\n");
  const after = assignSectionIds(render(lines), prefix).markdown.split("\n");
  expect(after).toHaveLength(before.length);
  for (const [index, line] of before.entries()) {
    const isBareHeading = lines[index]?.kind === "heading";
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
  expect(new Set(added).size).toBe(added.length);
  for (const id of added) {
    expect(sectionIdsOf(markdown).filter((existing) => existing === id)).toHaveLength(1);
  }
});

it("a section takes its parent section's ID as its namespace", () => {
  const { markdown } = assignSectionIds(
    ["# Plan", "## Saved views", "### Persist filter state", "## Saved views"].join("\n"),
    "spec",
  );
  expect(markdown.split("\n")).toEqual([
    "# Plan {#spec.plan}",
    "## Saved views {#spec.saved-views}",
    "### Persist filter state {#spec.saved-views.persist-filter-state}",
    "## Saved views {#spec.saved-views-2}",
  ]);
});
