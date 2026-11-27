import { PrdSectionId } from "@cairn/contract";
import type { End, SectionId, TaskId, TaskStatus } from "@cairn/contract";
import {
  Array,
  HashSet,
  MutableHashMap,
  Number,
  Option,
  Order,
  Record,
  Result,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";

import type { RelationIndex, StatusOf } from "./relation-index.ts";
import { chainOf } from "./rollup.ts";
import { TaskIdOrder } from "./task-order.ts";

/** A heading or list item of the PRD, as the links read it: its ID and what it sits under. */
export interface TreeEntry {
  readonly id: SectionId | undefined;
  readonly parent: SectionId | null | undefined;
}

/**
 * What sits under what: the PRD's headings and items, as a trace's `prd` or `sectionsOf` and
 * `itemsOf` of `prd.md` give them, and the spec's headings, as a trace's `spec.sections` or
 * `sectionsOf` of `spec.md`. A spec section implements what the sections above it implement.
 */
export interface SectionTree {
  readonly items: ReadonlyArray<TreeEntry>;
  readonly sections: ReadonlyArray<TreeEntry>;
  readonly spec: ReadonlyArray<TreeEntry>;
}

/** `task` needs `needs`: one of the pairs of tasks that make a link. */
export interface TaskPair {
  readonly needs: TaskId;
  readonly task: TaskId;
}

/** A section or item at the other end of a link, and the pairs of tasks that make the link. */
export interface SectionLink {
  readonly id: PrdSectionId;
  /** In `TaskIdOrder` of `task`, then of `needs`. */
  readonly pairs: ReadonlyArray<TaskPair>;
  /**
   * With `transitive`, the first direct link through which this one is reached. None for a direct
   * link, and for one reached only through tasks that link to no section.
   */
  readonly via: Option.Option<PrdSectionId>;
}

/** One of the section's unfinished tasks. */
export interface NextTask {
  readonly canStart: boolean;
  readonly task: TaskId;
  /** Its unfinished direct needs, in `TaskIdOrder`. */
  readonly waitsOn: ReadonlyArray<TaskId>;
}

/** What a PRD section or item needs, what needs it and what it can build next. */
export interface SectionLinks {
  /** In build order of the tasks at the other end, then by ID. */
  readonly needs: ReadonlyArray<SectionLink>;
  /** In build order of the tasks at the other end, then by ID. */
  readonly neededBy: ReadonlyArray<SectionLink>;
  /** The unfinished tasks among `tasks`: the ones that can start, then the rest, each in build order. */
  readonly next: ReadonlyArray<NextTask>;
  /** How many of `next` can start. */
  readonly ready: number;
  /** The section's own tasks, in build order: the tasks linked to it or to anything under it. */
  readonly tasks: ReadonlyArray<TaskId>;
}

export interface SectionLinksOptions {
  /** The derived status of each task. */
  readonly statusOf: StatusOf;
  /** Everything before and after the section, in build order, instead of its direct links. */
  readonly transitive?: boolean;
}

const FINISHED: ReadonlyArray<TaskStatus> = ["done", "landed"];

const isPrdSectionId = Schema.is(PrdSectionId);

/** One step along `needs`, in either direction: `near` is on the section's side. */
interface Edge {
  readonly far: TaskId;
  readonly near: TaskId;
}

/** A link with the far tasks it was made from, and the first of them in build order. */
interface Found {
  readonly far: ReadonlyArray<TaskId>;
  readonly first: number;
  readonly link: SectionLink;
}

const PairOrder: Order.Order<TaskPair> = Order.combine(
  Order.mapInput(TaskIdOrder, (pair: TaskPair) => pair.task),
  Order.mapInput(TaskIdOrder, (pair: TaskPair) => pair.needs),
);

const FoundOrder: Order.Order<Found> = Order.combine(
  Order.mapInput(Number.Order, (found: Found) => found.first),
  Order.mapInput(String.Order, (found: Found) => found.link.id),
);

/** The PRD section and item IDs among `ends`, each once. */
const idsOf = (ends: ReadonlyArray<End>): ReadonlyArray<PrdSectionId> =>
  Array.dedupe(
    Array.filter(
      Array.map(ends, (end) => end.id),
      isPrdSectionId,
    ),
  );

const samePair = (self: TaskPair, that: TaskPair) =>
  self.task === that.task && self.needs === that.needs;

/** The links of one section or item, with everything the plan shares already worked out. */
export type SectionLinker = (id: PrdSectionId, transitive?: boolean) => SectionLinks;

/**
 * What `sectionLinksOf` reads of the whole plan, worked out once: the tree, the build order, what
 * each task needs and links to, and which sections each task rolls up to. The function it returns
 * answers for one section or item at a time, so a reader asking for every heading of a PRD does
 * the plan-wide work once (see `spec.status.section-links`).
 *
 * A task links directly to the sections and items it names, and to those that the spec sections it
 * builds implement, with what they inherit from the spec sections above them. The section's own
 * tasks are those that roll up to it (see `spec.sections.item-coverage`): a task rolls up to what it
 * names and to the items its spec sections implement, and so to everything above them. A section
 * needs each section or item outside it that a task needed by one of its own tasks links to
 * directly, when that task is not one of its own; `neededBy` is the same the other way.
 */
export const sectionLinkerOf = (
  index: RelationIndex,
  prd: SectionTree,
  statusOf: StatusOf,
): SectionLinker => {
  const parents = pipe(
    Array.flatten([prd.sections, prd.items, prd.spec]),
    Array.map((entry) =>
      Option.all([Option.fromNullishOr(entry.id), Option.fromNullishOr(entry.parent)]),
    ),
    Array.getSomes,
    Record.fromEntries,
  );
  // Each ID with the IDs above it, itself included, worked out the first time it is asked for.
  const chains = MutableHashMap.empty<string, HashSet.HashSet<string>>();
  const chainSetOf = (id: string): HashSet.HashSet<string> =>
    Option.getOrElse(MutableHashMap.get(chains, id), () => {
      const chain = HashSet.fromIterable(chainOf(parents, id));
      MutableHashMap.set(chains, id, chain);
      return chain;
    });

  // Every task once: in build order, then the tasks in a cycle.
  const all: ReadonlyArray<TaskId> = Array.appendAll(
    index.buildOrder(),
    Array.flatten(index.cycles),
  );
  const ranks = Record.fromEntries(Array.map(all, (task, at) => [task, at] as const));
  const rankOf = (task: TaskId) =>
    Option.getOrElse(Record.get(ranks, task), () => Array.length(all));
  const tableOf = <A>(of: (task: TaskId) => A) =>
    Record.fromEntries(Array.map(all, (task) => [task, of(task)] as const));
  const tasksAt = (ids: HashSet.HashSet<string>) =>
    Array.filter(all, (task) => HashSet.has(ids, task));
  const needsTable = tableOf((task) =>
    tasksAt(HashSet.fromIterable(Array.map(index.out(task, "needs"), ({ to }) => to.id))),
  );
  const neededByTable = tableOf((task) =>
    tasksAt(HashSet.fromIterable(Array.map(index.into(task, "needs"), ({ from }) => from.id))),
  );
  const needsOf = (task: TaskId): ReadonlyArray<TaskId> =>
    Option.getOrElse(Record.get(needsTable, task), () => []);
  const neededByOf = (task: TaskId): ReadonlyArray<TaskId> =>
    Option.getOrElse(Record.get(neededByTable, task), () => []);

  const namedOf = (task: TaskId) => Array.map(index.out(task, "names"), ({ to }) => to);
  /** What the spec sections `task` builds implement, with what they inherit from the ones above. */
  const implementedOf = (task: TaskId) =>
    Array.flatMap(index.out(task, "builds"), ({ to }) =>
      Array.flatMap(chainOf(parents, to.id), (built) =>
        Array.map(index.out(built, "implements"), (implemented) => implemented.to),
      ),
    );
  // A link's other end is any section or item a task links to directly. A section's own tasks
  // follow the rollup: a task rolls up to what it names, and to the items, not the headings, that
  // its spec sections implement, and so to everything above those.
  const targets = tableOf((task) => idsOf(Array.appendAll(namedOf(task), implementedOf(task))));
  const rolledUnder = tableOf((task) =>
    HashSet.fromIterable(
      Array.flatMap(
        idsOf(
          Array.appendAll(
            namedOf(task),
            Array.filter(implementedOf(task), ({ kind }) => kind === "item"),
          ),
        ),
        (rolled) => chainOf(parents, rolled),
      ),
    ),
  );
  const targetsOf = (task: TaskId): ReadonlyArray<PrdSectionId> =>
    Option.getOrElse(Record.get(targets, task), () => []);
  const nextOf = tableOf((task): NextTask => ({
    canStart: index.canStart(task, statusOf),
    task,
    waitsOn: index.waitsOn(task, statusOf),
  }));

  return (id, transitive = false) => {
    const isInside = (other: string) => HashSet.has(chainSetOf(other), id);
    const own = Array.filter(all, (task) =>
      Option.exists(Record.get(rolledUnder, task), (under) => HashSet.has(under, id)),
    );
    const ownSet = HashSet.fromIterable(own);
    const isOwn = (task: TaskId) => HashSet.has(ownSet, task);

    /**
     * The steps along `step` from the section's own tasks to a task that is not one of them; with
     * `transitive`, also every step between the tasks that `reach` gives from its own tasks.
     */
    const edgesOf = (
      step: (task: TaskId) => ReadonlyArray<TaskId>,
      reach: (task: TaskId) => ReadonlyArray<TaskId>,
      further: boolean,
    ): ReadonlyArray<Edge> => {
      const reached = further
        ? HashSet.fromIterable(Array.filter(Array.flatMap(own, reach), (task) => !isOwn(task)))
        : HashSet.empty<TaskId>();
      const isFar = (task: TaskId) => (further ? HashSet.has(reached, task) : !isOwn(task));
      const nears: ReadonlyArray<TaskId> = Array.appendAll(
        own,
        Array.filter(all, (task) => HashSet.has(reached, task)),
      );
      return Array.flatMap(nears, (near) =>
        Array.map(Array.filter(step(near), isFar), (far): Edge => ({ far, near })),
      );
    };

    const foundOf = (edges: ReadonlyArray<Edge>, pairOf: (edge: Edge) => TaskPair) =>
      pipe(
        Array.flatMap(edges, (edge) =>
          Array.map(
            Array.filter(targetsOf(edge.far), (target) => !isInside(target)),
            (target) => ({ edge, target }),
          ),
        ),
        Array.groupBy(({ target }) => target),
        Record.values,
        Array.map((entries): Found => {
          const far = Array.dedupe(Array.map(entries, ({ edge }) => edge.far));
          return {
            far,
            first: Array.reduce(far, Array.length(all), (least, task) =>
              Number.min(least, rankOf(task)),
            ),
            link: {
              id: Array.headNonEmpty(entries).target,
              pairs: Array.sort(
                Array.dedupeWith(
                  Array.map(entries, ({ edge }) => pairOf(edge)),
                  samePair,
                ),
                PairOrder,
              ),
              via: Option.none(),
            },
          };
        }),
        (found) => Array.sort(found, FoundOrder),
      );

    const sideOf = (
      step: (task: TaskId) => ReadonlyArray<TaskId>,
      reach: (task: TaskId) => ReadonlyArray<TaskId>,
      pairOf: (edge: Edge) => TaskPair,
    ): ReadonlyArray<SectionLink> => {
      const direct = foundOf(edgesOf(step, reach, false), pairOf);
      const leadsTo = (from: TaskId, to: TaskId) => from === to || Array.contains(reach(from), to);
      const viaOf = (found: Found) =>
        Array.some(direct, ({ link }) => link.id === found.link.id)
          ? Option.none()
          : Option.map(
              Array.findFirst(direct, (through) =>
                Array.some(through.far, (from) => Array.some(found.far, (to) => leadsTo(from, to))),
              ),
              ({ link }) => link.id,
            );
      return transitive
        ? Array.map(foundOf(edgesOf(step, reach, true), pairOf), (found) =>
            Struct.evolve(found.link, { via: () => viaOf(found) }),
          )
        : Array.map(direct, ({ link }) => link);
    };

    const unfinished = Array.getSomes(
      Array.map(
        Array.filter(own, (task) => !Array.contains(FINISHED, statusOf(task))),
        (task) => Record.get(nextOf, task),
      ),
    );
    const [ready, waiting] = Array.partition(unfinished, (task) =>
      task.canStart ? Result.succeed(task) : Result.fail(task),
    );
    return {
      neededBy: sideOf(neededByOf, index.neededByAll, ({ far, near }) => ({
        needs: near,
        task: far,
      })),
      needs: sideOf(needsOf, index.needsAll, ({ far, near }) => ({ needs: far, task: near })),
      next: Array.appendAll(ready, waiting),
      ready: Array.length(ready),
      tasks: own,
    };
  };
};

/**
 * The links of the PRD section or item `id` (see `spec.status.section-links` and
 * `sectionLinkerOf`). It is pure: what needs what comes from `index`, and `prd` says only what
 * sits under what. A caller asking for many sections builds one `sectionLinkerOf` instead.
 */
export const sectionLinksOf = (
  index: RelationIndex,
  prd: SectionTree,
  id: PrdSectionId,
  { statusOf, transitive = false }: SectionLinksOptions,
): SectionLinks => sectionLinkerOf(index, prd, statusOf)(id, transitive);
