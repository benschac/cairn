import { PrdSectionId, SpecIndexJson, SpecSectionId } from "@cairn/contract";
import type { BodyHash, IndexedSection, ManifestTask, Section, SpecIndex } from "@cairn/contract";
import { bodyHashOf, keyEntriesOf, sectionsOf } from "@cairn/core";
import {
  Array,
  Effect,
  HashSet,
  Option,
  Predicate,
  Record,
  Result,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";

import { Planner } from "./planner.ts";
import type { PlannerError } from "./planner.ts";
import { CAIRN_DIRECTORY } from "./workspace.ts";

/** The fields of a section's entry that `Planner.index` fills in. */
const PROSE_FIELDS = ["artifacts", "decisions", "requirements", "summary", "tests"] as const;

/** How many sections are indexed at once. */
const CONCURRENCY = 4;

/** What `specIndexOf` reads (see `spec.contract.spec-index`). */
export interface SpecIndexInput {
  /** The text of `prd.md`. */
  readonly prd: string;
  /** The text of `spec.md`. */
  readonly spec: string;
  /** Its tasks fill each section's `tasks`. A plan whose tasks are not drafted yet has none. */
  readonly manifest: { readonly tasks: ReadonlyArray<ManifestTask> };
  /** `spec.json` as it is on disk, if it is. A section it has keeps its entry. */
  readonly previous: Option.Option<SpecIndex>;
  /**
   * Sections with an entry in `previous` whose body changed, so `Planner.index` reads them again.
   * A section with no entry is always indexed. The entry cannot say whether the body changed:
   * `writtenFrom.body` is the body as it was first written, and is null for a person's section.
   */
  readonly changed: ReadonlyArray<SpecSectionId>;
  /**
   * Sections Cairn writes or rewrites in this run, which are indexed again. Each records the
   * hash of its body in `writtenFrom`, replacing an old one. Any other section keeps the
   * `writtenFrom` of its entry, or records null when it has none, because a person wrote it.
   */
  readonly written: ReadonlyArray<SpecSectionId>;
}

const isSpecSectionId = Schema.is(SpecSectionId);
const isPrdSectionId = Schema.is(PrdSectionId);

/** A section of `spec.md` that has a spec section ID. */
interface Identified {
  readonly id: SpecSectionId;
  readonly section: Section;
}

const identifiedOf = (sections: ReadonlyArray<Section>): ReadonlyArray<Identified> =>
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
const parentOf = (section: Section): SpecSectionId | null =>
  pipe(Option.fromNullishOr(section.parent), Option.filter(isSpecSectionId), Option.getOrNull);

/** The fields of an entry that code derives from `spec.md` and `manifest.json`, and `writtenFrom`. */
type Derived = Omit<IndexedSection, (typeof PROSE_FIELDS)[number]>;

/**
 * The derived fields of every section of `spec.md` that has an ID, in document order.
 * `writtenFrom` is made for a section in `written` and for one `previous` does not have; any
 * other keeps the one in `previous`.
 */
export const derivedOf = (input: Omit<SpecIndexInput, "changed">): ReadonlyArray<Derived> => {
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
  return Array.map(identified, ({ id, section }): Derived => {
    const own = (key: string) => ownValuesOf(section, key);
    const implemented = Array.filter(own("Implements"), isPrdSectionId);
    return {
      children: Array.filterMap(identified, (other) =>
        parentOf(other.section) === id ? Result.succeed(other.id) : Result.failVoid,
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
      parent: parentOf(section),
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

/**
 * The sections of `previous` that a person edited since Cairn wrote them: the hash of the body
 * differs from `writtenFrom.body`. These are the `changed` sections of `SpecIndexInput`. The index
 * records no hash for a section a person wrote, so an edit to one is not seen here.
 */
export const editedOf = (spec: string, previous: SpecIndex): ReadonlyArray<SpecSectionId> => {
  const bodies = Record.fromEntries(
    Array.map(identifiedOf(sectionsOf(spec)), ({ id, section }) => [id, section.body] as const),
  );
  return Array.filterMap(previous.sections, (entry) =>
    Option.exists(
      Option.flatMap(Option.fromNullOr(entry.writtenFrom.body), (hash) =>
        Option.map(Record.get(bodies, entry.id), (body) => hash !== bodyHashOf(body)),
      ),
      (differs) => differs,
    )
      ? Result.succeed(entry.id)
      : Result.failVoid,
  );
};

/**
 * `spec.json` for `spec.md` and `manifest.json`. Code fills the derived fields from the files.
 * `Planner.index` fills the prose fields of each section that is new or named in `changed`; any
 * other section keeps the prose of its entry in `previous`. A section that left `spec.md` leaves
 * the index.
 */
export const specIndexOf = Effect.fn("specIndexOf")(function* (
  input: SpecIndexInput,
): Effect.fn.Return<SpecIndex, PlannerError, Planner> {
  const planner = yield* Planner;
  const identified = identifiedOf(sectionsOf(input.spec));
  const previous = Record.fromEntries(
    Array.map(
      Option.match(input.previous, { onNone: () => [], onSome: (index) => index.sections }),
      (entry) => [entry.id, entry] as const,
    ),
  );
  const changed = HashSet.fromIterable(Array.appendAll(input.changed, input.written));
  const sections = yield* Effect.forEach(
    Array.zip(derivedOf(input), identified),
    ([derived, { section }]) =>
      Option.match(
        Option.filter(Record.get(previous, derived.id), () => !HashSet.has(changed, derived.id)),
        {
          onNone: () =>
            planner
              .index({ body: section.body, id: derived.id, title: section.title })
              .pipe(Effect.map((prose): IndexedSection => ({ ...derived, ...prose }))),
          onSome: (entry) =>
            Effect.succeed<IndexedSection>({
              ...derived,
              ...Struct.pick(entry, PROSE_FIELDS),
            }),
        },
      ),
    { concurrency: CONCURRENCY },
  );
  return {
    manifest: `${CAIRN_DIRECTORY}/manifest.json`,
    prd: `${CAIRN_DIRECTORY}/prd.md`,
    sections,
    source: `${CAIRN_DIRECTORY}/spec.md`,
    version: 1,
  };
});

/** `spec.json` as the file holds it: indented JSON ending in a newline. */
export const specIndexText = (index: SpecIndex) =>
  Schema.encodeEffect(SpecIndexJson)(index).pipe(
    Effect.map((text) => (String.endsWith("\n")(text) ? text : `${text}\n`)),
  );
