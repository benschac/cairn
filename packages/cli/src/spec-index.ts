import { IndexProse, SpecIndexJson, SpecSectionId } from "@cairn/contract";
import type { IndexedSection, ManifestTask, SpecIndex, StatementId } from "@cairn/contract";
import {
  bodyHashOf,
  derivedOf,
  identifiedOf,
  itemsOf,
  readHashOf,
  sectionsOf,
  statementsOf,
  taskStatementsOf,
  withoutStackDiagram,
} from "@cairn/core";
import {
  Array,
  Console,
  Effect,
  HashSet,
  Option,
  Record,
  Result,
  Schema,
  String,
  Struct,
  Tuple,
} from "effect";

import { Planner } from "./planner.ts";
import type { PlannerError } from "./planner.ts";
import { CAIRN_DIRECTORY } from "./workspace.ts";

/**
 * How many sections are indexed at once. Each is one small model call, and with the `cli` source
 * one process of the agent CLI, which spends most of its time waiting for the model.
 */
const CONCURRENCY = 8;

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
   * Sections with an entry in `previous` that was not read from the body the section has now, so
   * `Planner.index` reads them again: `editedOf` finds them. A section with no entry is always
   * indexed. Each section that is read records the hash of its body in `indexedFrom`, so it is not
   * read again until the body changes.
   */
  readonly changed: ReadonlyArray<SpecSectionId>;
  /**
   * Sections Cairn writes or rewrites in this run, which are indexed again. Each records the
   * hash of its body in `writtenFrom`, replacing an old one. Any other section keeps the
   * `writtenFrom` of its entry, or records null when it has none, because a person wrote it.
   */
  readonly written: ReadonlyArray<SpecSectionId>;
  /**
   * Sections Cairn edited in place without writing them again, such as one an item was added to the
   * `Implements` of (`spec.planning.again.mapping-items`). Each records the hash of its body now in
   * `writtenFrom.body` and keeps the recorded PRD hashes.
   */
  readonly rehashed?: ReadonlyArray<SpecSectionId> | undefined;
}

/**
 * What `Planner.index` reads of a section: its body without the stack diagram, which code draws
 * from the manifest. So a section that holds the diagram is not read again each time a task
 * changes, and the planner is not sent the diagram.
 */
const readOf = withoutStackDiagram;

/**
 * The sections whose entry was read from a body that `spec.md` no longer has: the hash of the body
 * differs from `indexedFrom`. The stack diagram is not part of what is compared. An entry made
 * before `indexedFrom` was recorded has none. One for a section Cairn wrote is compared with
 * `writtenFrom.body`, the body as Cairn wrote it. One for a section a person wrote has a null
 * `writtenFrom.body` and so nothing to compare: nothing shows that its prose is still what the
 * body says, and it is named. Either is read once more and then has an `indexedFrom`. These are
 * the `changed` sections of `SpecIndexInput`.
 */
export const editedOf = (spec: string, previous: SpecIndex): ReadonlyArray<SpecSectionId> => {
  const bodies = Record.fromEntries(
    Array.map(identifiedOf(sectionsOf(spec)), ({ id, section }) => [id, section.body] as const),
  );
  return Array.filterMap(previous.sections, (entry) =>
    Option.exists(
      Record.get(bodies, entry.id),
      (body) =>
        !Option.contains(
          Option.orElse(Option.fromUndefinedOr(entry.indexedFrom), () =>
            Option.fromNullOr(entry.writtenFrom.body),
          ),
          readHashOf(body),
        ),
    )
      ? Result.succeed(entry.id)
      : Result.failVoid,
  );
};

/**
 * `prose` with each test's `proves` cut down to the IDs in `known`, the statements of the PRD.
 * A model can name a statement the PRD does not have; a warning names the section and the IDs left
 * out (see `spec.planning.done-when.tracing-statements`).
 */
const knownProofsOf = Effect.fn("knownProofsOf")(function* (
  section: SpecSectionId,
  known: HashSet.HashSet<StatementId>,
  prose: IndexProse,
) {
  const dropped = Array.dedupe(
    Array.flatMap(prose.tests, ({ proves }) =>
      Array.filter(proves, (id) => !HashSet.has(known, id)),
    ),
  );
  yield* Array.isReadonlyArrayNonEmpty(dropped)
    ? Console.log(
        `Warning: left out ${Array.join(dropped, ", ")} from the tests of ${section}, which the PRD has no statement for.`,
      )
    : Effect.void;
  return Struct.evolve(prose, {
    tests: (tests) =>
      Array.map(tests, (test) =>
        Struct.evolve(test, {
          proves: (proves) => Array.filter(proves, (id) => HashSet.has(known, id)),
        }),
      ),
  });
});

/**
 * `spec.json` for `spec.md` and `manifest.json`. Code fills the derived fields from the files.
 * `Planner.index` fills the prose fields of each section that is new or named in `changed`; any
 * other section keeps the prose of its entry in `previous`. A test proves only statements the PRD
 * has. Each task lists the statements it carries and the tests that prove them. A section that left
 * `spec.md` leaves the index.
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
  const rehashed = HashSet.fromIterable<string>(
    Option.getOrElse(
      Option.fromUndefinedOr(input.rehashed),
      (): ReadonlyArray<SpecSectionId> => [],
    ),
  );
  const prdSections = sectionsOf(input.prd);
  const statements = statementsOf(input.prd, prdSections, itemsOf(input.prd, prdSections));
  const known = HashSet.fromIterable(
    Array.getSomes(Array.map(statements, ({ id }) => Option.fromUndefinedOr(id))),
  );
  const sections = yield* Effect.forEach(
    Array.map(Array.zip(derivedOf(input), identified), ([derived, { section }]) =>
      Tuple.make(
        HashSet.has(rehashed, derived.id)
          ? Struct.evolve(derived, {
              writtenFrom: (from) => Struct.assign(from, { body: bodyHashOf(section.body) }),
            })
          : derived,
        section,
      ),
    ),
    ([derived, section]) =>
      Option.match(
        Option.filter(Record.get(previous, derived.id), () => !HashSet.has(changed, derived.id)),
        {
          onNone: () =>
            planner
              .index({ body: readOf(section.body), id: derived.id, title: section.title })
              .pipe(
                Effect.flatMap((prose) => knownProofsOf(derived.id, known, prose)),
                Effect.map((prose): IndexedSection => ({
                  ...derived,
                  ...prose,
                  indexedFrom: readHashOf(section.body),
                })),
              ),
          // The prose is kept, and so is the hash of the body it was read from, if the entry has one.
          onSome: (entry) =>
            knownProofsOf(
              derived.id,
              known,
              Struct.pick(entry, Struct.keys(IndexProse.fields)),
            ).pipe(
              Effect.map((prose): IndexedSection => ({
                ...derived,
                ...prose,
                ...Struct.pick(entry, ["indexedFrom"]),
              })),
            ),
        },
      ),
    { concurrency: CONCURRENCY },
  );
  return {
    manifest: `${CAIRN_DIRECTORY}/manifest.json`,
    prd: `${CAIRN_DIRECTORY}/prd.md`,
    sections,
    source: `${CAIRN_DIRECTORY}/spec.md`,
    tasks: Array.map(input.manifest.tasks, (task) => ({
      id: task.id,
      statements: taskStatementsOf(task, statements, sections),
    })),
    version: 1,
  };
});

/** `spec.json` as the file holds it: indented JSON ending in a newline. */
export const specIndexText = (index: SpecIndex) =>
  Schema.encodeEffect(SpecIndexJson)(index).pipe(
    Effect.map((text) => (String.endsWith("\n")(text) ? text : `${text}\n`)),
  );
