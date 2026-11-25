import type {
  Section,
  SectionId,
  SectionStatus,
  TaskStatus,
  Trace,
  TraceTask,
} from "@cairn/contract";
import { Array, HashSet, Option, Record, pipe } from "effect";

import type { Item } from "./items.ts";

/** What the rollup reads of a task: the sections it links to and its derived status. */
export type RollupTask = Pick<TraceTask, "prdSections" | "specSections" | "status">;

/** What the rollup reads of a PRD list item: its ID, and the item or heading it sits under. */
export type RollupItem = Pick<Item, "id" | "parent">;

/** One entry of `Trace.sections`. */
export type RolledSection = Trace["sections"][number];

/** Rule 3, in order: the first of these that any linked task has is the section's status. */
const URGENT: ReadonlyArray<TaskStatus> = ["blocked_on_human", "failed", "running"];

/** Rule 4, in order: a status, and the task statuses a section may have for it. */
const UNANIMOUS: ReadonlyArray<readonly [SectionStatus, ReadonlyArray<TaskStatus>]> = [
  ["landed", ["landed"]],
  ["done", ["done", "landed"]],
  ["pending", ["pending"]],
];

/** Rules 3 to 5 for a section with at least one linked task. */
const rolledStatus = (statuses: ReadonlyArray<TaskStatus>): SectionStatus =>
  pipe(
    Array.findFirst(URGENT, (status) => Array.contains(statuses, status)),
    Option.orElse(() =>
      pipe(
        Array.findFirst(UNANIMOUS, ([, allowed]) =>
          Array.every(statuses, (status) => Array.contains(allowed, status)),
        ),
        Option.map(([status]) => status),
      ),
    ),
    Option.getOrElse((): SectionStatus => "in_progress"),
  );

/** IDs are plain strings here: a PRD ID, a spec ID and a section ID are different brands. */
export type Parents = Record<string, string>;

/** Each section's and item's parent, for those that have an ID and a parent. */
export const parentsOf = (
  sections: ReadonlyArray<Pick<Section, "id" | "parent">>,
  items: ReadonlyArray<RollupItem> = [],
): Parents =>
  pipe(
    Array.appendAll(sections, items),
    Array.map(({ id, parent }) =>
      Option.all([Option.fromUndefinedOr(id), Option.fromUndefinedOr(parent)]),
    ),
    Array.getSomes,
    Record.fromEntries,
  );

/**
 * A section and the sections above it, nearest first. Duplicate IDs can make the parents loop
 * (`cairn lint` reports them), so the walk takes at most one step per section.
 */
export const chainOf = (parents: Parents, id: string): ReadonlyArray<string> =>
  Array.unfold({ at: Option.some(id), left: Record.size(parents) + 1 }, ({ at, left }) =>
    Option.filter(at, () => left > 0).pipe(
      Option.map((here) => [here, { at: Record.get(parents, here), left: left - 1 }]),
    ),
  );

/** The PRD IDs that a key of some spec section names. */
const namedBy = (
  spec: ReadonlyArray<Section>,
  key: "context" | "defers",
): HashSet.HashSet<string> =>
  HashSet.fromIterable<string>(Array.flatMap(spec, (section) => section.keys[key]));

/**
 * Rule 1 for a PRD section: a `Defers` or `Context` key names it or a section above it, and
 * `Defers` is checked first.
 */
const prdSays = (
  deferred: HashSet.HashSet<string>,
  context: HashSet.HashSet<string>,
  chain: ReadonlyArray<string>,
): Option.Option<SectionStatus> =>
  pipe(
    Array.findFirst(
      [
        ["deferred", deferred],
        ["context", context],
      ] as const,
      ([, named]) => Array.some(chain, (id) => HashSet.has(named, id)),
    ),
    Option.map(([status]) => status),
  );

/** Rule 1 for a spec section: its own keys, with the ones it inherits, are `Defers` or `Context`. */
const specSays = ({ keys }: Section): Option.Option<SectionStatus> =>
  pipe(
    Array.findFirst(
      [
        ["deferred", keys.defers],
        ["context", keys.context],
      ] as const,
      ([, ids]) => Array.isReadonlyArrayNonEmpty(ids),
    ),
    Option.map(([status]) => status),
  );

/**
 * The IDs of the PRD items that a spec section implements, by the section's ID. A section's keys
 * hold the ones it inherits, so a section under an `Implements` implements the same items.
 */
const implementedItems = (
  spec: ReadonlyArray<Section>,
  items: ReadonlyArray<RollupItem>,
): Record<string, ReadonlyArray<string>> => {
  const known = HashSet.fromIterable<string>(
    Array.getSomes(Array.map(items, ({ id }) => Option.fromUndefinedOr(id))),
  );
  return pipe(
    spec,
    Array.map((section) =>
      Option.map(
        Option.fromUndefinedOr(section.id),
        (id) =>
          [
            id,
            Array.filter(section.keys.implements, (named) => HashSet.has(known, named)),
          ] as const,
      ),
    ),
    Array.getSomes,
    Record.fromEntries,
  );
};

/**
 * Every section's status, rolled up from its tasks (see `spec.status.section-rollup`): the PRD's
 * sections in document order, then the PRD's items with an ID in document order, then the spec's
 * sections. A section with no `id` is left out. A task links to the sections in its `prdSections`
 * and `specSections`, and through them to every section and item above them in the tree, so a
 * section is rolled up from its own tasks and its descendants'. A task also links to the PRD items
 * that its spec sections implement (see `spec.sections.item-coverage`), not to the sections that
 * hold them. The task statuses are the derived ones. `items` are the PRD's; a spec item is not
 * rolled up.
 */
export const rollupOf = (
  prd: ReadonlyArray<Section>,
  spec: ReadonlyArray<Section>,
  tasks: ReadonlyArray<RollupTask>,
  items: ReadonlyArray<RollupItem> = [],
): ReadonlyArray<RolledSection> => {
  const parents = parentsOf(Array.appendAll(prd, spec), items);
  const implemented = implementedItems(spec, items);
  const linked = pipe(
    tasks,
    Array.flatMap(({ prdSections, specSections, status }) =>
      pipe(
        Array.appendAll(
          Array.appendAll<string, string>(prdSections, specSections),
          Array.flatMap(specSections, (id) =>
            Option.getOrElse(Record.get(implemented, id), (): ReadonlyArray<string> => []),
          ),
        ),
        Array.flatMap((id) => chainOf(parents, id)),
        Array.map((id) => ({ id, status })),
      ),
    ),
    Array.groupBy(({ id }) => id),
    Record.map(Array.map(({ status }) => status)),
  );
  const deferred = namedBy(spec, "defers");
  const context = namedBy(spec, "context");
  const rolled = (id: SectionId, says: Option.Option<SectionStatus>): RolledSection => ({
    id,
    status: Option.getOrElse(says, () =>
      pipe(
        Record.get(linked, id),
        Option.match({ onNone: (): SectionStatus => "unmapped", onSome: rolledStatus }),
      ),
    ),
  });
  const ofPrd = Array.map(prd, (section) =>
    Option.map(Option.fromUndefinedOr(section.id), (id) =>
      rolled(id, prdSays(deferred, context, chainOf(parents, id))),
    ),
  );
  const ofItems = Array.map(items, (item) =>
    Option.map(Option.fromUndefinedOr(item.id), (id) =>
      rolled(id, prdSays(deferred, context, chainOf(parents, id))),
    ),
  );
  const ofSpec = Array.map(spec, (section) =>
    Option.map(Option.fromUndefinedOr(section.id), (id) => rolled(id, specSays(section))),
  );
  return Array.getSomes(Array.flatten([ofPrd, ofItems, ofSpec]));
};
