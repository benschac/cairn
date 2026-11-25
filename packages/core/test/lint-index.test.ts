import type { IndexedSection, SpecIndex } from "@cairn/contract";
import { SpecSectionId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, String, Struct } from "effect";

import { derivedOf, lint } from "../src/index.ts";
import type { Finding, LintRule } from "../src/index.ts";

/** Section levels as a spec may have them: at least level 2, and no level deeper than one below the one before. */
const Levels = Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 2 }))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(10),
);

const levelsOf = (raw: ReadonlyArray<number>): ReadonlyArray<number> =>
  Array.mapAccum(raw, 1, (previous, level) => {
    const kept = level > previous + 1 ? previous + 1 : level;
    return [kept, kept];
  })[1];

const PRD = "# Product {#prd.product}\n";

/** A spec with section `i` as `spec.s<i>` at the generated level, touching `src/s<i>.ts`. */
const specOf = (levels: ReadonlyArray<number>): string =>
  Array.join(
    Array.prepend(
      Array.map(
        levels,
        (level, index) =>
          `${String.repeat(level)("#")} Section ${index} {#spec.s${index}}\n\n- Files: \`src/s${index}.ts\`\n`,
      ),
      "# Spec {#spec.spec}\n",
    ),
    "\n",
  );

/** The index `cairn plan` writes for `spec` with no tasks: every derived field, and empty prose. */
const indexFor = (spec: string): SpecIndex => ({
  manifest: ".cairn/manifest.json",
  prd: ".cairn/prd.md",
  sections: Array.map(
    derivedOf({ manifest: { tasks: [] }, prd: PRD, previous: Option.none(), spec, written: [] }),
    (derived) => ({
      ...derived,
      artifacts: [],
      decisions: [],
      requirements: [],
      summary: "",
      tests: [],
    }),
  ),
  source: ".cairn/spec.md",
  version: 1,
});

const lintIndex = (spec: string, index: SpecIndex) =>
  lint(PRD, spec, Option.none(), { humanPaths: [] }, Option.some(index));

const only = (findings: ReadonlyArray<Finding>, rule: LintRule) =>
  Array.filter(findings, (finding) => finding.rule === rule);

/** The field `index-drift` is asked to catch, each changed so that it differs from the files. */
const Field = Schema.Literals(["files", "human", "line", "title"]);

const drifted = (entry: IndexedSection, field: typeof Field.Type): IndexedSection =>
  Struct.evolve(entry, {
    files: (files) => (field === "files" ? Array.append(files, "extra.ts") : files),
    human: (human) => (field === "human" ? !human : human),
    line: (line) => (field === "line" ? line + 1 : line),
    title: (title) => (field === "title" ? `${title}!` : title),
  });

const ghostId = Schema.decodeSync(SpecSectionId)("spec.ghost");

it.prop("an index derived from the files has no index-drift finding", [Levels], ([raw]) => {
  const spec = specOf(levelsOf(raw));
  expect(only(lintIndex(spec, indexFor(spec)), "index-drift")).toEqual([]);
});

it.prop(
  "a derived field that spec.json gets wrong is one index-drift finding, naming the section and the field",
  {
    field: Field,
    levels: Levels,
    pick: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
  },
  ({ field, levels: raw, pick }) => {
    const spec = specOf(levelsOf(raw));
    const index = indexFor(spec);
    const at = pick % Array.length(index.sections);
    const entry = Option.getOrThrow(Array.get(index.sections, at));
    const wrong: SpecIndex = Struct.evolve(index, {
      sections: (sections) =>
        Array.map(sections, (section, position) =>
          position === at ? drifted(section, field) : section,
        ),
    });
    expect(only(lintIndex(spec, wrong), "index-drift")).toEqual([
      {
        file: "spec.json",
        line: Option.none(),
        message: `${entry.id}'s ${field} in spec.json differs from spec.md or manifest.json. Run cairn plan.`,
        rule: "index-drift",
        severity: "warning",
      },
    ]);
  },
);

it.prop(
  "a section with no entry in spec.json is one index-drift finding",
  { levels: Levels, pick: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })) },
  ({ levels: raw, pick }) => {
    const spec = specOf(levelsOf(raw));
    const index = indexFor(spec);
    const at = pick % Array.length(index.sections);
    const missing = Option.getOrThrow(Array.get(index.sections, at)).id;
    const without: SpecIndex = Struct.evolve(index, {
      sections: (sections) => Array.filter(sections, (section) => section.id !== missing),
    });
    expect(only(lintIndex(spec, without), "index-drift")).toEqual([
      {
        file: "spec.json",
        line: Option.none(),
        message: `spec.json has no entry for ${missing}. Run cairn plan.`,
        rule: "index-drift",
        severity: "warning",
      },
    ]);
  },
);

it.prop("an entry for no section of spec.md is one index-drift finding", [Levels], ([raw]) => {
  const spec = specOf(levelsOf(raw));
  const index = indexFor(spec);
  const first = Option.getOrThrow(Array.get(index.sections, 0));
  const extra: SpecIndex = Struct.evolve(index, {
    sections: (sections) => Array.append(sections, { ...first, id: ghostId }),
  });
  expect(only(lintIndex(spec, extra), "index-drift")).toEqual([
    {
      file: "spec.json",
      line: Option.none(),
      message: `spec.json has an entry for spec.ghost, which spec.md does not have. Run cairn plan.`,
      rule: "index-drift",
      severity: "warning",
    },
  ]);
});

it("prose and writtenFrom are not compared, so an index with them changed has no index-drift finding", () => {
  const spec = specOf([2, 3]);
  const index = indexFor(spec);
  const reworded: SpecIndex = Struct.evolve(index, {
    sections: (sections) =>
      Array.map(sections, (section) => ({
        ...section,
        summary: "A new summary.",
        writtenFrom: { body: null, prd: {} },
      })),
  });
  expect(only(lintIndex(spec, reworded), "index-drift")).toEqual([]);
});
