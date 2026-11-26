import { PrdSectionId, SpecSectionId } from "@cairn/contract";
import type { BodyHash, DerivedSection, ManifestTask, Section, SpecIndex } from "@cairn/contract";
import { Array, HashSet, Option, Predicate, Record, Result, Schema, String, pipe } from "effect";

import { identifiedOf } from "./identified.ts";
import type { IdentifiedSection } from "./identified.ts";
import { bodyHashOf, readHashOf } from "./replan.ts";
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

export { identifiedOf, type IdentifiedSection };

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

/** The hash of each of `ids` that `hashes` has: a section that does not exist records none. */
const hashesOf = <Id extends string>(
  ids: ReadonlyArray<Id>,
  hashes: Record.ReadonlyRecord<string, BodyHash>,
) =>
  Record.fromEntries(
    Array.filterMap(ids, (id) =>
      Option.match(Record.get(hashes, id), {
        onNone: () => Result.failVoid,
        onSome: (hash) => Result.succeed([id, hash] as const),
      }),
    ),
  );

/**
 * The derived fields of every section of `spec.md` that has an ID, in document order.
 * `writtenFrom` is made for a section in `written` and for one `previous` does not have; any
 * other keeps the one in `previous`. It records the hash of each PRD section the section
 * implements and of each spec section it depends on, as they are in `prd` and `spec`.
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
  const specHashes: Record.ReadonlyRecord<string, BodyHash> = Record.fromEntries(
    Array.map(identified, ({ id, section }) => [id, readHashOf(section.body)] as const),
  );
  const written = HashSet.fromIterable(input.written);
  return Array.map(identified, ({ id, section }): DerivedSection => {
    const own = (key: string) => ownValuesOf(section, key);
    const implemented = Array.filter(own("Implements"), isPrdSectionId);
    const dependsOn = Array.filter(own("Depends on"), isSpecSectionId);
    return {
      children: Array.filterMap(identified, (other) =>
        indexParentOf(other.section) === id ? Result.succeed(other.id) : Result.failVoid,
      ),
      context: Array.filter(own("Context"), isPrdSectionId),
      defers: Array.filter(own("Defers"), isPrdSectionId),
      dependsOn,
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
          prd: hashesOf(implemented, prdHashes),
          spec: hashesOf(dependsOn, specHashes),
        }),
      ),
    };
  });
};
