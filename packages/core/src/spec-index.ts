import { IndexedSection, PrdSectionId, SpecSectionId } from "@cairn/contract";
import type { BodyHash, ManifestTask, Section, SpecIndex } from "@cairn/contract";
import { Array, HashSet, Option, Predicate, Record, Result, Schema, String, pipe } from "effect";

import { bodyHashOf } from "./replan.ts";
import { keyEntriesOf, sectionsOf } from "./sections.ts";

const isSpecSectionId = Schema.is(SpecSectionId);
const isPrdSectionId = Schema.is(PrdSectionId);

/** What `derivedOf` reads: the files the derived fields come from, and the previous `spec.json`. */
export interface DerivedInput {
  /** The text of `prd.md`. */
  readonly prd: string;
  /** The text of `spec.md`. */
  readonly spec: string;
  /** Its tasks fill each section's `tasks`. */
  readonly manifest: { readonly tasks: ReadonlyArray<ManifestTask> };
  /** `spec.json` as it is on disk, if it is; the source of `writtenFrom` for a section not in `written`. */
  readonly previous: Option.Option<SpecIndex>;
  /** Sections whose `writtenFrom` is made again. */
  readonly written: ReadonlyArray<SpecSectionId>;
}

/** A section of `spec.md` that has a spec section ID. */
export interface IdentifiedSection {
  readonly id: SpecSectionId;
  readonly section: Section;
}

export const identifiedOf = (sections: ReadonlyArray<Section>): ReadonlyArray<IdentifiedSection> =>
  Array.filterMap(sections, (section) =>
    Predicate.isNotUndefined(section.id) && isSpecSectionId(section.id)
      ? Result.succeed({ id: section.id, section })
      : Result.failVoid,
  );

/**
 * The values the section itself lists under `key`. `Section.keys` also holds what the headings
 * above it list, which the index leaves out.
 */
const ownValuesOf = (section: Section, key: string): ReadonlyArray<string> =>
  Array.flatMap(keyEntriesOf(String.split(section.body, "\n")), ([name, values]) =>
    name === key ? values : [],
  );

/** The section above it that has a spec section ID, which is its parent in the index. */
const indexParentOf = (section: Section): SpecSectionId | null =>
  pipe(Option.fromNullishOr(section.parent), Option.filter(isSpecSectionId), Option.getOrNull);

/** The fields of an entry that code derives from `spec.md` and `manifest.json`, and `writtenFrom`. */
export type DerivedSection = Omit<
  IndexedSection,
  "artifacts" | "decisions" | "requirements" | "summary" | "tests"
>;

/**
 * The derived fields of every section of `spec.md` that has an ID, in document order.
 * `writtenFrom` is made for a section in `written` and for one `previous` does not have; any
 * other keeps the one in `previous`.
 */
export const derivedOf = (input: DerivedInput): ReadonlyArray<DerivedSection> => {
  const identified = identifiedOf(sectionsOf(input.spec));
  const prdHashes: Record.ReadonlyRecord<string, BodyHash> = Record.fromEntries(
    Array.filterMap(sectionsOf(input.prd), (section) =>
      Predicate.isUndefined(section.id)
        ? Result.failVoid
        : Result.succeed([section.id, bodyHashOf(section.body)] as const),
    ),
  );
  const recorded = Record.fromEntries(
    Array.map(
      Option.match(input.previous, { onNone: () => [], onSome: (index) => index.sections }),
      (entry) => [entry.id, entry.writtenFrom] as const,
    ),
  );
  const written = HashSet.fromIterable(input.written);
  return Array.map(identified, ({ id, section }): DerivedSection => {
    const own = (key: string) => ownValuesOf(section, key);
    const implemented = Array.filter(own("Implements"), isPrdSectionId);
    return {
      children: Array.filterMap(identified, (other) =>
        indexParentOf(other.section) === id ? Result.succeed(other.id) : Result.failVoid,
      ),
      context: Array.filter(own("Context"), isPrdSectionId),
      defers: Array.filter(own("Defers"), isPrdSectionId),
      dependsOn: Array.filter(own("Depends on"), isSpecSectionId),
      files: own("Files"),
      human: section.human,
      id,
      implements: implemented,
      level: section.level,
      line: section.line,
      parent: indexParentOf(section),
      tasks: Array.filterMap(input.manifest.tasks, (task) =>
        Array.contains(task.specSections, id) ? Result.succeed(task.id) : Result.failVoid,
      ),
      title: section.title,
      writtenFrom: Option.getOrElse(
        Option.filter(Record.get(recorded, id), () => !HashSet.has(written, id)),
        () => ({
          body: HashSet.has(written, id) ? bodyHashOf(section.body) : null,
          prd: Record.fromEntries(
            Array.filterMap(implemented, (prd) =>
              Option.match(Record.get(prdHashes, prd), {
                onNone: () => Result.failVoid,
                onSome: (hash) => Result.succeed([prd, hash] as const),
              }),
            ),
          ),
        }),
      ),
    };
  });
};
