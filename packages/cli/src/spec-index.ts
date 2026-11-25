import { SpecIndexJson, SpecSectionId } from "@cairn/contract";
import type { IndexedSection, ManifestTask, SpecIndex } from "@cairn/contract";
import { bodyHashOf, derivedOf, identifiedOf, sectionsOf } from "@cairn/core";
import { Array, Effect, HashSet, Option, Record, Result, Schema, String, Struct } from "effect";

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
    tasks: [],
    version: 1,
  };
});

/** `spec.json` as the file holds it: indented JSON ending in a newline. */
export const specIndexText = (index: SpecIndex) =>
  Schema.encodeEffect(SpecIndexJson)(index).pipe(
    Effect.map((text) => (String.endsWith("\n")(text) ? text : `${text}\n`)),
  );
