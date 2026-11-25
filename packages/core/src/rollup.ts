import type {
  Section,
  SectionId,
  SectionStatus,
  TaskStatus,
  Trace,
  TraceTask,
} from "@cairn/contract";
import { Array, HashSet, Option, Record, pipe } from "effect";

/** What the rollup reads of a task: the sections it links to and its derived status. */
export type RollupTask = Pick<TraceTask, "prdSections" | "specSections" | "status">;

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
type Parents = Record<string, string>;

/** Each section's parent, for the sections that have an ID and a parent. */
const parentsOf = (sections: ReadonlyArray<Section>): Parents =>
  pipe(
    sections,
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
const chainOf = (parents: Parents, id: string): ReadonlyArray<string> =>
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
 * Every section's status, rolled up from its tasks (see `spec.status.section-rollup`): the PRD's
 * sections in document order, then the spec's. A section with no `id` is left out. A task links
 * to the sections in its `prdSections` and `specSections`, and through them to every section above
 * them in the heading tree, so a section is rolled up from its own tasks and its descendants'.
 * The task statuses are the derived ones.
 */
export const rollupOf = (
  prd: ReadonlyArray<Section>,
  spec: ReadonlyArray<Section>,
  tasks: ReadonlyArray<RollupTask>,
): ReadonlyArray<RolledSection> => {
  const parents = parentsOf(Array.appendAll(prd, spec));
  const linked = pipe(
    tasks,
    Array.flatMap(({ prdSections, specSections, status }) =>
      pipe(
        Array.appendAll(prdSections, specSections),
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
  const ofSpec = Array.map(spec, (section) =>
    Option.map(Option.fromUndefinedOr(section.id), (id) => rolled(id, specSays(section))),
  );
  return Array.getSomes(Array.appendAll(ofPrd, ofSpec));
};
