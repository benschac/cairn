import { createHash } from "node:crypto";

import { BodyHash, PrdSectionId, SpecSectionId, TaskId } from "@cairn/contract";
import type {
  IndexedSection,
  Manifest,
  ManifestTask,
  Section,
  SectionId,
  SpecIndex,
} from "@cairn/contract";
import {
  Array,
  HashSet,
  Option,
  Order,
  Predicate,
  Record,
  Result,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";

import type { Part } from "./part.ts";
import { itemsOf } from "./items.ts";
import type { Item } from "./items.ts";
import { chainOf, parentsOf } from "./rollup.ts";
import type { Parents } from "./rollup.ts";
import { keyEntriesOf, sectionsOf } from "./sections.ts";

/**
 * The hash `writtenFrom` records for a section's body (see `spec.contract.spec-index`): the
 * SHA-256 of the body with trailing whitespace removed from each line, in hex.
 */
export const bodyHashOf = (body: string): BodyHash =>
  BodyHash.make(
    createHash("sha256")
      .update(pipe(String.split(body, "\n"), Array.map(String.trimEnd), Array.join("\n")))
      .digest("hex"),
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

/**
 * The section code writes for the stack diagram (`withStackDiagram`). Its `Context` key names the
 * PRD's top section, which would cover every section under it, so what it names is left out of
 * coverage: the diagram builds nothing and says nothing about what the PRD asks for.
 */
const STACKS_SECTION = "spec.stacks";

/** What the spec's keys name: every ID in any key, and the ones whose coverage spreads to what is under them. */
const namedBySpec = (
  allSpec: ReadonlyArray<Section>,
): { readonly named: HashSet.HashSet<string>; readonly spread: HashSet.HashSet<string> } => {
  const spec = Array.filter(allSpec, (section) => section.id !== STACKS_SECTION);
  return {
    named: HashSet.fromIterable<string>(
      Array.flatMap(spec, ({ keys }) =>
        Array.flatten([keys.implements, keys.defers, keys.context]),
      ),
    ),
    spread: HashSet.fromIterable<string>(
      Array.flatMap(spec, ({ keys }) => Array.appendAll(keys.defers, keys.context)),
    ),
  };
};

/** What coverage reads of a PRD list item: its ID, the heading it is under and the item or heading above it. */
export type CoverageItem = Pick<Item, "id" | "parent" | "section">;

/**
 * PRD sections no spec section covers (see `spec.format`). A section is covered when it, or a
 * section under it, is named in an `Implements`, `Defers` or `Context` key, or when a section
 * above it is named in a `Defers` or `Context` key. An item under it that is named in a key
 * counts as a section under it. The stack diagram's section covers nothing. A heading with no ID
 * is left out.
 */
export const uncoveredOf = (
  prd: ReadonlyArray<Section>,
  allSpec: ReadonlyArray<Section>,
  items: ReadonlyArray<CoverageItem> = [],
): ReadonlyArray<{ readonly id: SectionId; readonly section: Section }> => {
  const { named, spread } = namedBySpec(allSpec);
  const parents = parentsOf(prd);
  const namedItems = Array.filter(items, ({ id }) =>
    Option.exists(Option.fromUndefinedOr(id), (itemId) => HashSet.has(named, itemId)),
  );
  const placed = placedOf(prd);
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
      Array.some(ancestors, (above) => HashSet.has(spread, above)) ||
      Array.some(namedItems, ({ section: heading }) =>
        Option.exists(Option.fromUndefinedOr(heading), (at) =>
          Array.contains(chainOf(parents, at), id),
        ),
      );
    return covered ? Result.failVoid : Result.succeed({ id, section });
  });
};

/**
 * PRD items with an ID that no spec section covers (see `spec.sections.item-coverage`). An item is
 * covered when an `Implements`, `Defers` or `Context` key names it, or when a `Defers` or
 * `Context` key names a heading or an item it sits under. An `Implements` that names the section
 * around it does not cover it. `prd` are the PRD's sections, which give the heading tree above the
 * items. The stack diagram's section covers nothing.
 */
export const uncoveredItemsOf = <I extends CoverageItem>(
  prd: ReadonlyArray<Section>,
  allSpec: ReadonlyArray<Section>,
  items: ReadonlyArray<I>,
): ReadonlyArray<I & { readonly id: SectionId }> => {
  const { named, spread } = namedBySpec(allSpec);
  const parents = parentsOf(prd, items);
  return Array.filterMap(items, (item) => {
    const { id } = item;
    return Predicate.isUndefined(id) ||
      HashSet.has(named, id) ||
      Array.some(chainOf(parents, id), (above) => HashSet.has(spread, above))
      ? Result.failVoid
      : Result.succeed({ ...item, id });
  });
};

/** A section's ID when it is a spec section's. */
const specIdOf = (section: Section): Option.Option<SpecSectionId> =>
  Option.filter(Option.fromUndefinedOr(section.id), Schema.is(SpecSectionId));

/** The spec section IDs the tasks name in `specSections`. */
const builtBy = (tasks: ReadonlyArray<ManifestTask>): HashSet.HashSet<string> =>
  HashSet.fromIterable<string>(Array.flatMap(tasks, (task) => task.specSections));

/** The section lists a `Files` key of its own, not one it inherits. */
const hasFiles = (section: Section): boolean =>
  Array.some(keyEntriesOf(String.split(section.body, "\n")), ([name]) => name === "Files");

/**
 * Spec sections with their own `Files` key that no task names in `specSections`, and that are
 * not above a section a task names: such a section is built by its children's tasks.
 */
const untaskedOf = (
  spec: ReadonlyArray<Section>,
  tasks: ReadonlyArray<ManifestTask>,
): ReadonlyArray<SpecSectionId> => {
  const built = builtBy(tasks);
  const placed = placedOf(spec);
  const aboveBuilt = (id: SpecSectionId) =>
    Array.some(
      placed,
      (below) =>
        Array.contains(below.ancestors, id) &&
        Predicate.isNotUndefined(below.section.id) &&
        HashSet.has(built, below.section.id),
    );
  return Array.getSomes(
    Array.map(placed, ({ section }) =>
      Option.filter(
        specIdOf(section),
        (id) => hasFiles(section) && !HashSet.has(built, id) && !aboveBuilt(id),
      ),
    ),
  );
};

/** A spec section of `spec.md` with its entry in `spec.json`. */
interface Recorded {
  readonly entry: IndexedSection;
  readonly id: SpecSectionId;
  readonly section: Section;
}

/** A person edited the section: its body hash differs from the one Cairn wrote. */
const edited = ({ entry, section }: Recorded): boolean =>
  Option.exists(
    Option.fromNullOr(entry.writtenFrom.body),
    (hash) => hash !== bodyHashOf(section.body),
  );

/** Cairn wrote the section and nobody edited it since. */
const untouched = (found: Recorded): boolean =>
  Predicate.isNotNull(found.entry.writtenFrom.body) && !edited(found);

/** Each spec section of `spec.md` that `spec.json` has, with its entry, in document order. */
const recordedOf = (spec: ReadonlyArray<Section>, index: SpecIndex): ReadonlyArray<Recorded> => {
  const entries = Record.fromEntries(
    Array.map(index.sections, (entry) => [entry.id, entry] as const),
  );
  return Array.getSomes(
    Array.map(spec, (section) =>
      Option.flatMap(specIdOf(section), (id) =>
        Option.map(Record.get(entries, id), (entry): Recorded => ({ entry, id, section })),
      ),
    ),
  );
};

/** A spec section that implements PRD sections that changed after it was written. */
export interface StaleSection extends Recorded {
  /** The PRD sections whose hash differs from `writtenFrom`, a deleted one included. */
  readonly changed: Array.NonEmptyReadonlyArray<PrdSectionId>;
}

/** A task that builds spec sections that are stale, or that were edited after it was planned. */
export interface StaleTask {
  readonly edited: ReadonlyArray<SpecSectionId>;
  readonly stale: ReadonlyArray<SpecSectionId>;
  readonly task: ManifestTask;
}

/** What went out of date since the spec was written (see `spec.planning.again`). */
export interface Staleness {
  /** Out-of-date sections Cairn wrote, nobody edited and no task builds: `cairn plan` writes them again. */
  readonly rewritable: ReadonlyArray<SpecSectionId>;
  /** Every out-of-date section, rewritable or not, in document order. */
  readonly outOfDate: ReadonlyArray<StaleSection>;
  /** Every other out-of-date section: a person settles it. */
  readonly sections: ReadonlyArray<StaleSection>;
  readonly tasks: ReadonlyArray<StaleTask>;
}

/**
 * Which spec sections and tasks went out of date. A spec section is out of date when a PRD
 * section its `writtenFrom` records has a different hash now; it was edited when its body hash
 * differs from `writtenFrom.body`. A section of `spec.md` that `spec.json` does not have is left
 * out: nothing records what it was written from.
 */
export const stalenessOf = (
  prd: ReadonlyArray<Section>,
  spec: ReadonlyArray<Section>,
  index: SpecIndex,
  tasks: ReadonlyArray<ManifestTask>,
): Staleness => {
  const prdHashes: Record.ReadonlyRecord<string, BodyHash> = Record.fromEntries(
    Array.filterMap(prd, (section) =>
      Predicate.isUndefined(section.id)
        ? Result.failVoid
        : Result.succeed([section.id, bodyHashOf(section.body)] as const),
    ),
  );
  const built = builtBy(tasks);
  const recorded = recordedOf(spec, index);
  const outOfDate = Array.filterMap(recorded, (found): Result.Result<StaleSection, void> => {
    const changed = Array.filterMap(Record.toEntries(found.entry.writtenFrom.prd), ([id, hash]) =>
      Option.exists(Record.get(prdHashes, id), (now) => now === hash)
        ? Result.failVoid
        : Result.succeed(id),
    );
    return Array.isReadonlyArrayNonEmpty(changed)
      ? Result.succeed({ changed, entry: found.entry, id: found.id, section: found.section })
      : Result.failVoid;
  });
  const isRewritable = (found: StaleSection) => untouched(found) && !HashSet.has(built, found.id);
  const sections = Array.filter(outOfDate, (found) => !isRewritable(found));
  const staleIds = HashSet.fromIterable<string>(Array.map(sections, ({ id }) => id));
  const editedIds = HashSet.fromIterable<string>(
    Array.map(Array.filter(recorded, edited), ({ id }) => id),
  );
  return {
    outOfDate,
    rewritable: Array.map(Array.filter(outOfDate, isRewritable), ({ id }) => id),
    sections,
    tasks: Array.filterMap(tasks, (task): Result.Result<StaleTask, void> => {
      const stale = Array.filter(task.specSections, (id) => HashSet.has(staleIds, id));
      const editedHere = Array.filter(
        task.specSections,
        (id) => HashSet.has(editedIds, id) && !HashSet.has(staleIds, id),
      );
      return Array.isReadonlyArrayEmpty(stale) && Array.isReadonlyArrayEmpty(editedHere)
        ? Result.failVoid
        : Result.succeed({ edited: editedHere, stale, task });
    }),
  };
};

/**
 * A PRD item with an ID that no key covers, and the spec sections that may already build it
 * (`spec.planning.again.mapping-items`): those that implement the heading the item is under or an
 * item it sits under, by their own `Implements` or one they inherit, that have an `Implements`
 * line of their own for `withImplements` to add the item to, and that Cairn wrote and nobody
 * edited.
 */
export const UnmappedItem = Schema.Struct({
  item: PrdSectionId,
  candidates: Schema.Array(SpecSectionId),
});
export type UnmappedItem = typeof UnmappedItem.Type;

/** The section has an `Implements` key of its own, not only one it inherits. */
const hasOwnImplements = (section: Section): boolean =>
  Array.some(keyEntriesOf(String.split(section.body, "\n")), ([name]) => name === "Implements");

/** The heading an item is under and the items between it and that heading, nearest first. */
const aboveOf = (
  parents: Parents,
  item: CoverageItem & { readonly id: SectionId },
): ReadonlyArray<string> => {
  const chain = Array.drop(chainOf(parents, item.id), 1);
  return Option.match(Option.fromUndefinedOr(item.section), {
    onNone: () => chain,
    onSome: (heading) =>
      Array.append(
        Array.takeWhile(chain, (id) => id !== heading),
        heading,
      ),
  });
};

/**
 * Every PRD item with an ID that nothing covers (`uncoveredItemsOf`), in document order, with its
 * candidate spec sections in document order (see `UnmappedItem`). Pure.
 */
export const unmappedItemsOf = (
  prd: ReadonlyArray<Section>,
  spec: ReadonlyArray<Section>,
  items: ReadonlyArray<CoverageItem>,
  index: SpecIndex,
): ReadonlyArray<UnmappedItem> => {
  const parents = parentsOf(prd, items);
  const writable = Array.filter(recordedOf(spec, index), untouched);
  return Array.filterMap(uncoveredItemsOf(prd, spec, items), (item) => {
    const above = aboveOf(parents, item);
    return Schema.is(PrdSectionId)(item.id)
      ? Result.succeed({
          candidates: Array.filterMap(writable, ({ id, section }) =>
            hasOwnImplements(section) &&
            Array.some(section.keys.implements, (named) => Array.contains(above, named))
              ? Result.succeed(id)
              : Result.failVoid,
          ),
          item: item.id,
        })
      : Result.failVoid;
  });
};

/** What a second `cairn plan` has to do (see `spec.planning.again`). Each list is in document or manifest order. */
export const Replan = Schema.Struct({
  /** Spec sections Cairn wrote, nobody edited and no task builds, whose PRD sections changed: written again. */
  rewritable: Schema.Array(SpecSectionId),
  /** Every other spec section that implements a changed PRD section: reported. */
  staleSections: Schema.Array(SpecSectionId),
  /** Tasks that build a stale spec section, or one edited after they were planned: reported. */
  staleTasks: Schema.Array(TaskId),
  /** PRD sections no spec section covers: new spec sections are written for them. */
  uncovered: Schema.Array(PrdSectionId),
  /** PRD items with an ID that nothing covers, with the spec sections the judge is asked about: mapped, planned or reported. */
  unmappedItems: Schema.Array(UnmappedItem),
  /** Spec sections with a `Files` key that no task builds, and not above one that a task builds: tasks are drafted for them. */
  untasked: Schema.Array(SpecSectionId),
});
export type Replan = typeof Replan.Type;

/**
 * What a second `cairn plan` adds to a plan (see `spec.planning.again`). `prd` and `spec` are the
 * markdown of `prd.md` and `spec.md`, `index` is `spec.json`, and there is no manifest when the
 * tasks have not been planned yet. Nothing here changes a task: the existing ones are reported,
 * never rewritten.
 */
export const replanOf = (
  prd: string,
  spec: string,
  index: SpecIndex,
  manifest: Option.Option<Manifest>,
): Replan => {
  const prdSections = sectionsOf(prd);
  const specSections = sectionsOf(spec);
  const tasks = Option.match(manifest, {
    onNone: (): ReadonlyArray<ManifestTask> => [],
    onSome: (plan) => plan.tasks,
  });
  const staleness = stalenessOf(prdSections, specSections, index, tasks);
  return {
    rewritable: staleness.rewritable,
    staleSections: Array.map(staleness.sections, ({ id }) => id),
    staleTasks: Array.map(staleness.tasks, ({ task }) => task.id),
    uncovered: Array.filter(
      Array.map(uncoveredOf(prdSections, specSections), ({ id }) => id),
      Schema.is(PrdSectionId),
    ),
    unmappedItems: unmappedItemsOf(prdSections, specSections, itemsOf(prd, prdSections), index),
    untasked: untaskedOf(specSections, tasks),
  };
};

/**
 * Every spec section a PRD section it was written from has changed since, rewritable or not, in
 * document order, with the PRD sections that changed and its `spec.json` entry, whose
 * `writtenFrom.prd` holds the hashes it was written from (`spec.planning.again.cosmetic-edits`).
 * Pure.
 */
export const outOfDateOf = (
  prd: string,
  spec: string,
  index: SpecIndex,
): ReadonlyArray<StaleSection> =>
  stalenessOf(sectionsOf(prd), sectionsOf(spec), index, []).outOfDate;

/**
 * `replan` with the edits a judge read as cosmetic left unwritten
 * (`spec.planning.again.cosmetic-edits`): every `rewritable` section whose changed PRD sections
 * are all in `cosmetic` moves to `staleSections`, which stays in document order. `outOfDate`
 * gives each section's changed PRD sections and that order (`outOfDateOf`); a rewritable section
 * it does not name stays rewritable. Nothing else changes. Pure.
 */
export const cosmeticOf = (
  replan: Replan,
  cosmetic: HashSet.HashSet<PrdSectionId>,
  outOfDate: ReadonlyArray<Pick<StaleSection, "changed" | "id">>,
): Replan => {
  const changedOf = Record.fromEntries(
    Array.map(outOfDate, ({ changed, id }) => [id, changed] as const),
  );
  const moves = (id: SpecSectionId) =>
    Option.exists(Record.get(changedOf, id), (changed) =>
      Array.every(changed, (prd) => HashSet.has(cosmetic, prd)),
    );
  const order = Array.map(outOfDate, ({ id }): SpecSectionId => id);
  const placeOf = (id: SpecSectionId) =>
    Option.getOrElse(
      Array.findFirstIndex(order, (other) => other === id),
      () => Array.length(order),
    );
  return Struct.assign(replan, {
    rewritable: Array.filter(replan.rewritable, (id) => !moves(id)),
    staleSections: Array.sortWith(
      Array.appendAll(replan.staleSections, Array.filter(replan.rewritable, moves)),
      placeOf,
      Order.Number,
    ),
  });
};

/**
 * The PRD sections each section of `spec.json` implements: its own `Implements` and those of the
 * sections above it. The index records only a section's own key, in document order, so a parent's
 * entry is made before its children's.
 */
const implementedOf = (
  index: SpecIndex,
): Record.ReadonlyRecord<string, ReadonlyArray<PrdSectionId>> =>
  Array.reduce(index.sections, Record.empty<string, ReadonlyArray<PrdSectionId>>(), (done, entry) =>
    Record.set(
      done,
      entry.id,
      Array.dedupe(
        Array.appendAll(
          Option.getOrElse(
            Option.flatMap(Option.fromNullOr(entry.parent), (parent) => Record.get(done, parent)),
            () => [],
          ),
          entry.implements,
        ),
      ),
    ),
  );

/**
 * What a part run of `cairn plan` acts on (see `spec.planning.planning-a-part`): `replan`, the
 * whole-plan `replanOf`, narrowed to `part`. `index` is `spec.json`, which gives each spec
 * section's own and inherited `Implements`.
 *
 * - `uncovered` keeps the PRD sections and items in the part, and `unmappedItems` the items.
 * - `rewritable` keeps the sections that implement something in the part and nothing outside it.
 *   One that implements both is moved to `staleSections`, so a part run never rewrites spec for
 *   another part; one wholly outside is left for its own part's run.
 * - `untasked` keeps the sections that implement something in the part. The sections the run
 *   writes are added by the command; a section `spec.json` does not have implements nothing here.
 * - `staleSections` and `staleTasks` are reported over the whole plan, as on any run.
 */
export const scopeOf = (replan: Replan, part: Part, index: SpecIndex): Replan => {
  const implemented = implementedOf(index);
  const implementsOf = (id: SpecSectionId) =>
    Option.getOrElse(Record.get(implemented, id), (): ReadonlyArray<PrdSectionId> => []);
  const inPart = (id: PrdSectionId) => HashSet.has(part.ids, id);
  const touches = (id: SpecSectionId) => Array.some(implementsOf(id), inPart);
  const within = (id: SpecSectionId) => touches(id) && Array.every(implementsOf(id), inPart);
  const order = Array.map(index.sections, ({ id }): SpecSectionId => id);
  const placeOf = (id: SpecSectionId) =>
    Option.getOrElse(
      Array.findFirstIndex(order, (other) => other === id),
      () => Array.length(order),
    );
  return {
    rewritable: Array.filter(replan.rewritable, within),
    staleSections: Array.sortWith(
      Array.appendAll(
        replan.staleSections,
        Array.filter(replan.rewritable, (id) => touches(id) && !within(id)),
      ),
      placeOf,
      Order.Number,
    ),
    staleTasks: replan.staleTasks,
    uncovered: Array.filter(replan.uncovered, inPart),
    unmappedItems: Array.filter(replan.unmappedItems, ({ item }) => inPart(item)),
    untasked: Array.filter(replan.untasked, touches),
  };
};
