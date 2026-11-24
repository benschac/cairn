import { SectionPrefix } from "@cairn/contract";
import type { Manifest, Section } from "@cairn/contract";
import { Array, HashSet, Option, Order, Predicate, Record, Result, Schema, String } from "effect";

import { keyEntriesOf, sectionsOf } from "./sections.ts";

/** The rules `lint` checks (see `spec.lint`). */
export const LintRule = Schema.Literals([
  "unknown-section",
  "unmapped-section",
  "missing-id",
  "duplicate-id",
  "wrong-prefix",
]);
export type LintRule = typeof LintRule.Type;

export const Severity = Schema.Literals(["error", "warning"]);
export type Severity = typeof Severity.Type;

/** The file a finding is in, relative to `.cairn/`. */
export const LintFile = Schema.Literals(["prd.md", "spec.md", "manifest.json"]);
export type LintFile = typeof LintFile.Type;

/**
 * One thing `lint` found. `line` is 1-based; a finding about a task in `manifest.json` has none,
 * since `lint` reads the decoded manifest, and its message names the task.
 */
export const Finding = Schema.Struct({
  file: LintFile,
  line: Schema.Option(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  message: Schema.String,
  rule: LintRule,
  severity: Severity,
});
export type Finding = typeof Finding.Type;

const SEVERITY: { readonly [Rule in LintRule]: Severity } = {
  "duplicate-id": "error",
  "missing-id": "error",
  "unknown-section": "error",
  "unmapped-section": "error",
  "wrong-prefix": "error",
};

const findingOf = (
  rule: LintRule,
  file: LintFile,
  line: Option.Option<number>,
  message: string,
): Finding => ({ file, line, message, rule, severity: SEVERITY[rule] });

/** A markdown file of the plan, parsed. */
interface Document {
  readonly file: LintFile;
  readonly prefix: SectionPrefix;
  readonly sections: ReadonlyArray<Section>;
}

/** A heading that has an ID, with where it is. */
interface Identified {
  readonly file: LintFile;
  readonly id: string;
  readonly line: number;
}

const identifiedOf = (document: Document): ReadonlyArray<Identified> =>
  Array.getSomes(
    Array.map(document.sections, (section) =>
      Option.map(Option.fromUndefinedOr(section.id), (id) => ({
        file: document.file,
        id,
        line: section.line,
      })),
    ),
  );

/** A section with the IDs of the headings above it. */
interface Placed {
  readonly ancestors: ReadonlyArray<string>;
  readonly section: Section;
}

/** Each section with its place in the heading tree: a heading is under the nearest one above it of a lower level. */
const placedOf = (sections: ReadonlyArray<Section>): ReadonlyArray<Placed> =>
  Array.mapAccum(sections, Array.empty<Section>(), (stack, section) => {
    const above = Array.filter(stack, (open) => open.level < section.level);
    const placed: Placed = {
      ancestors: Array.filterMap(above, (open) =>
        Predicate.isUndefined(open.id) ? Result.failVoid : Result.succeed(open.id),
      ),
      section,
    };
    return [Array.append(above, section), placed];
  })[1];

const missingIds = (document: Document): ReadonlyArray<Finding> =>
  Array.filterMap(document.sections, (section) =>
    Predicate.isUndefined(section.id)
      ? Result.succeed(
          findingOf(
            "missing-id",
            document.file,
            Option.some(section.line),
            `The heading "${section.title}" has no ID. Run cairn ids to add one.`,
          ),
        )
      : Result.failVoid,
  );

/** Every heading after the first with a given ID, in either file, pointing at the first. */
const duplicateIds = (headings: ReadonlyArray<Identified>): ReadonlyArray<Finding> =>
  Array.flatMap(Record.values(Array.groupBy(headings, (heading) => heading.id)), (group) => {
    const [first, ...later] = group;
    return Array.map(later, (heading) =>
      findingOf(
        "duplicate-id",
        heading.file,
        Option.some(heading.line),
        `${heading.id} is already the ID of the heading at ${first.file}:${first.line}.`,
      ),
    );
  });

const wrongPrefixes = (document: Document): ReadonlyArray<Finding> =>
  Array.filterMap(identifiedOf(document), (heading) =>
    String.startsWith(`${document.prefix}.`)(heading.id)
      ? Result.failVoid
      : Result.succeed(
          findingOf(
            "wrong-prefix",
            document.file,
            Option.some(heading.line),
            `${heading.id} is in ${document.file}, where every ID starts with ${document.prefix}.`,
          ),
        ),
  );

/** The file whose headings each key names. A `Files` key names paths. */
const KEY_TARGETS: Record.ReadonlyRecord<string, LintFile> = {
  Context: "prd.md",
  Defers: "prd.md",
  "Depends on": "spec.md",
  Implements: "prd.md",
};

/**
 * Values a spec section's own keys name that no heading has. Keys are read as written, so a value
 * with the other file's prefix is reported too; an inherited value is reported where it is written.
 */
const unknownInKeys = (
  spec: Document,
  prdIds: HashSet.HashSet<string>,
  specIds: HashSet.HashSet<string>,
): ReadonlyArray<Finding> =>
  Array.flatMap(spec.sections, (section) =>
    Array.flatMap(keyEntriesOf(String.split(section.body, "\n")), ([name, values]) =>
      Option.match(Record.get(KEY_TARGETS, name), {
        onNone: () => [],
        onSome: (file) =>
          Array.filterMap(values, (id) =>
            HashSet.has(file === "prd.md" ? prdIds : specIds, id)
              ? Result.failVoid
              : Result.succeed(
                  findingOf(
                    "unknown-section",
                    spec.file,
                    Option.some(section.line),
                    `${name} names ${id}, which no heading in ${file} has.`,
                  ),
                ),
          ),
      }),
    ),
  );

/** IDs a task names that no heading has, including a heading that was deleted. */
const unknownInTasks = (
  manifest: Manifest,
  prdIds: HashSet.HashSet<string>,
  specIds: HashSet.HashSet<string>,
): ReadonlyArray<Finding> =>
  Array.flatMap(manifest.tasks, (task) => {
    const unknown = (ids: ReadonlyArray<string>, known: HashSet.HashSet<string>, file: LintFile) =>
      Array.filterMap(ids, (id) =>
        HashSet.has(known, id)
          ? Result.failVoid
          : Result.succeed(
              findingOf(
                "unknown-section",
                "manifest.json",
                Option.none(),
                `${task.id} names ${id}, which no heading in ${file} has.`,
              ),
            ),
      );
    return Array.appendAll(
      unknown(task.prdSections, prdIds, "prd.md"),
      unknown(task.specSections, specIds, "spec.md"),
    );
  });

/**
 * PRD sections no spec section covers (see `spec.format`). A section is covered when it, or a
 * section under it, is named in an `Implements`, `Defers` or `Context` key, or when a section
 * above it is named in a `Defers` or `Context` key.
 */
const unmapped = (prd: Document, spec: Document): ReadonlyArray<Finding> => {
  const named = HashSet.fromIterable<string>(
    Array.flatMap(spec.sections, ({ keys }) =>
      Array.flatten([keys.implements, keys.defers, keys.context]),
    ),
  );
  const spread = HashSet.fromIterable<string>(
    Array.flatMap(spec.sections, ({ keys }) => Array.appendAll(keys.defers, keys.context)),
  );
  const placed = placedOf(prd.sections);
  return Array.filterMap(placed, ({ ancestors, section }) => {
    if (Predicate.isUndefined(section.id)) {
      return Result.failVoid;
    }
    const id = section.id;
    const covered =
      HashSet.has(named, id) ||
      Array.some(
        placed,
        (below) =>
          Array.contains(below.ancestors, id) &&
          Predicate.isNotUndefined(below.section.id) &&
          HashSet.has(named, below.section.id),
      ) ||
      Array.some(ancestors, (above) => HashSet.has(spread, above));
    return covered
      ? Result.failVoid
      : Result.succeed(
          findingOf(
            "unmapped-section",
            prd.file,
            Option.some(section.line),
            `${id} is not implemented, deferred or given as context by any spec section.`,
          ),
        );
  });
};

const FILE_ORDER: ReadonlyArray<LintFile> = ["prd.md", "spec.md", "manifest.json"];

/** By file, then by line; a finding with no line comes last in its file. */
const byPlace: Order.Order<Finding> = Order.combine(
  Order.mapInput(Order.Number, (finding: Finding) =>
    Option.getOrElse(
      Array.findFirstIndex(FILE_ORDER, (file) => file === finding.file),
      () => 0,
    ),
  ),
  Order.mapInput(Order.Number, (finding: Finding) =>
    Option.getOrElse(finding.line, () => Number.POSITIVE_INFINITY),
  ),
);

/**
 * What is wrong with a plan's section IDs and coverage (see `spec.lint`). `prd` and `spec` are
 * the markdown of `prd.md` and `spec.md`; there is no manifest before the tasks are planned.
 */
export const lint = (
  prd: string,
  spec: string,
  manifest: Option.Option<Manifest>,
): ReadonlyArray<Finding> => {
  const prdDocument: Document = { file: "prd.md", prefix: "prd", sections: sectionsOf(prd) };
  const specDocument: Document = { file: "spec.md", prefix: "spec", sections: sectionsOf(spec) };
  const prdIds = HashSet.fromIterable(Array.map(identifiedOf(prdDocument), ({ id }) => id));
  const specIds = HashSet.fromIterable(Array.map(identifiedOf(specDocument), ({ id }) => id));
  const findings = Array.flatten([
    missingIds(prdDocument),
    missingIds(specDocument),
    duplicateIds(Array.appendAll(identifiedOf(prdDocument), identifiedOf(specDocument))),
    wrongPrefixes(prdDocument),
    wrongPrefixes(specDocument),
    unknownInKeys(specDocument, prdIds, specIds),
    unmapped(prdDocument, specDocument),
    Option.match(manifest, {
      onNone: () => [],
      onSome: (plan) => unknownInTasks(plan, prdIds, specIds),
    }),
  ]);
  return Array.sort(findings, byPlace);
};
