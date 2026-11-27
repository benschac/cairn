import { PrdSectionId } from "@cairn/contract";
import type { SectionId, TaskId, TaskStatus } from "@cairn/contract";
import {
  Array,
  HashSet,
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
import { TaskIdOrder } from "./stacks.ts";

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

const samePair = (self: TaskPair, that: TaskPair) =>
  self.task === that.task && self.needs === that.needs;

/**
 * The links of the PRD section or item `id` (see `spec.status.section-links`). It is pure: what
 * needs what comes from `index`, and `prd` says only what sits under what.
 *
 * A task links directly to the sections and items it names, and to those that the spec sections it
 * builds implement, with what they inherit from the spec sections above them, as the rollup reads them. The section's own tasks are those linked directly to it or to anything under it.
 * It needs each section or item outside it that a task needed by one of its own tasks links to
 * directly, when that task is not one of its own; `neededBy` is the same the other way.
 */
export const sectionLinksOf = (
  index: RelationIndex,
  prd: SectionTree,
  id: PrdSectionId,
  { statusOf, transitive = false }: SectionLinksOptions,
): SectionLinks => {
  const parents = pipe(
    Array.flatten([prd.sections, prd.items, prd.spec]),
    Array.map((entry) =>
      Option.all([Option.fromNullishOr(entry.id), Option.fromNullishOr(entry.parent)]),
    ),
    Array.getSomes,
    Record.fromEntries,
  );
  const isInside = (other: string) => Array.contains(chainOf(parents, other), id);

  // Every task once: in build order, then the tasks in a cycle.
  const all: ReadonlyArray<TaskId> = Array.appendAll(
    index.buildOrder(),
    Array.flatten(index.cycles),
  );
  const ranks = Record.fromEntries(Array.map(all, (task, at) => [task, at] as const));
  const rankOf = (task: TaskId) =>
    Option.getOrElse(Record.get(ranks, task), () => Array.length(all));
  const tasksAt = (ids: ReadonlyArray<string>) =>
    Array.dedupe(Array.filter(all, (task) => Array.contains(ids, task)));
  const needsOf = (task: TaskId) => tasksAt(Array.map(index.out(task, "needs"), ({ to }) => to.id));
  const neededByOf = (task: TaskId) =>
    tasksAt(Array.map(index.into(task, "needs"), ({ from }) => from.id));

  const targets = Record.fromEntries(
    Array.map(
      all,
      (task) =>
        [
          task,
          Array.dedupe(
            Array.filter(
              Array.appendAll(
                Array.map(index.out(task, "names"), ({ to }) => to.id),
                Array.flatMap(index.out(task, "builds"), ({ to }) =>
                  Array.flatMap(chainOf(parents, to.id), (built) =>
                    Array.map(index.out(built, "implements"), (implemented) => implemented.to.id),
                  ),
                ),
              ),
              isPrdSectionId,
            ),
          ),
        ] as const,
    ),
  );
  const targetsOf = (task: TaskId): ReadonlyArray<PrdSectionId> =>
    Option.getOrElse(Record.get(targets, task), () => []);

  const own = Array.filter(all, (task) => Array.some(targetsOf(task), isInside));
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
      // A far task is not one of the section's own, so nothing it links to sits inside the section.
      Array.flatMap(edges, (edge) =>
        Array.map(targetsOf(edge.far), (target) => ({ edge, target })),
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

  const unfinished = Array.map(
    Array.filter(own, (task) => !Array.contains(FINISHED, statusOf(task))),
    (task): NextTask => ({
      canStart: index.canStart(task, statusOf),
      task,
      waitsOn: index.waitsOn(task, statusOf),
    }),
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
