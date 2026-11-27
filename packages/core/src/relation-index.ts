import { PrdSectionId, SpecSectionId } from "@cairn/contract";
import type {
  End,
  EndKind,
  IndexedSection,
  ManifestTask,
  Relation,
  RelationKind,
  StatementId,
  TaskId,
  TaskStatus,
  TestId,
  TraceDocument,
} from "@cairn/contract";
import { Array, HashSet, Option, Predicate, Record, Result, Schema, pipe } from "effect";

import { itemsOf } from "./items.ts";
import { headingsOf, linesOf } from "./section-ids.ts";
import { keyEntriesOf, sectionsOf } from "./sections.ts";
import { TaskIdOrder } from "./task-order.ts";
import { statementsOf } from "./statements.ts";

/** The part of a task the index reads. A `ManifestTask` and a `TraceTask` fit. */
export type IndexTask = Pick<
  ManifestTask,
  "dependsOn" | "id" | "orderedAfter" | "parent" | "prdSections" | "specSections"
>;

/** What a source of only tasks reads of each: what it needs and what it is built on. */
export type NeedsTask = Pick<ManifestTask, "dependsOn" | "id" | "parent">;

/**
 * What `indexOf` reads: the manifest, `spec.json` and the text of `prd.md`, or a trace, or only
 * the tasks, for the answers between tasks. Each names only the fields the index reads, so a
 * `Manifest`, a `SpecIndex`, a `Trace` and its tasks fit.
 */
export type RelationSource =
  | { readonly tasks: ReadonlyArray<NeedsTask> }
  | {
      readonly manifest: { readonly tasks: ReadonlyArray<IndexTask> };
      /** The text of `prd.md`. */
      readonly prd: string;
      readonly specIndex: {
        readonly sections: ReadonlyArray<
          Pick<IndexedSection, "dependsOn" | "id" | "implements" | "tests">
        >;
      };
    }
  | {
      readonly trace: {
        readonly prd: Pick<TraceDocument, "items" | "sections" | "statements">;
        readonly spec: Pick<TraceDocument, "markdown">;
        readonly tasks: ReadonlyArray<IndexTask>;
      };
    };

/** What a task's status is; the index reads statuses only through it. */
export type StatusOf = (task: TaskId) => TaskStatus;

/** The relations of a plan, and the answers the PRD asks of them (see `prd.relations.index`). */
export interface RelationIndex {
  /** The relations of `kind` that start at `id`: what it points at. */
  readonly out: (id: string, kind: RelationKind) => ReadonlyArray<Relation>;
  /** The relations of `kind` that end at `id`: what points at it. */
  readonly into: (id: string, kind: RelationKind) => ReadonlyArray<Relation>;
  /** Every task `task` needs, directly or through other tasks, in build order; tasks in a cycle last, in `TaskIdOrder`. */
  readonly needsAll: (task: TaskId) => ReadonlyArray<TaskId>;
  /** Every task that needs `task`, directly or through other tasks, in the same order. */
  readonly neededByAll: (task: TaskId) => ReadonlyArray<TaskId>;
  /** The tasks, or the given ones, topologically over `needs` with ties in `TaskIdOrder`; a task in a cycle is left out. */
  readonly buildOrder: (tasks?: Iterable<TaskId>) => ReadonlyArray<TaskId>;
  /** A pending task whose every needed task is `done` or `landed`. */
  readonly canStart: (task: TaskId, statusOf: StatusOf) => boolean;
  /** The unfinished tasks among those `task` directly needs, in `TaskIdOrder`. */
  readonly waitsOn: (task: TaskId, statusOf: StatusOf) => ReadonlyArray<TaskId>;
  /** The unfinished tasks that directly need `task`, in `TaskIdOrder`. */
  readonly waitedOnBy: (task: TaskId, statusOf: StatusOf) => ReadonlyArray<TaskId>;
  /** Neither needs the other, directly or not. */
  readonly canRunTogether: (a: TaskId, b: TaskId) => boolean;
  /** Relations with an end that does not exist; every answer above leaves them out. */
  readonly dangling: ReadonlyArray<Relation>;
  /** The strongly connected sets of tasks in `needs`, each in `TaskIdOrder`, ordered by their first task. */
  readonly cycles: ReadonlyArray<ReadonlyArray<TaskId>>;
}

/** A spec section as the extractors read it: its own `Implements` and `Depends on`. */
interface GraphSection {
  readonly dependsOn: ReadonlyArray<SpecSectionId>;
  readonly id: SpecSectionId;
  readonly implements: ReadonlyArray<PrdSectionId>;
}

/** A task as the extractors read it: a source of only tasks names no sections and has no ordering. */
interface GraphTask extends NeedsTask {
  readonly orderedAfter: IndexTask["orderedAfter"];
  readonly prdSections: ReadonlyArray<PrdSectionId>;
  readonly specSections: ReadonlyArray<SpecSectionId>;
}

/** The source, read into one shape: what each end can be and what each relation is read from. */
interface Graph {
  /** The IDs that exist, by the kind of end. */
  readonly ends: { readonly [K in EndKind]: HashSet.HashSet<string> };
  readonly proofs: ReadonlyArray<{ readonly statement: StatementId; readonly test: TestId }>;
  readonly sections: ReadonlyArray<GraphSection>;
  readonly tasks: ReadonlyArray<GraphTask>;
}

type Extractor = (graph: Graph) => ReadonlyArray<Relation>;

const end = (kind: EndKind, id: string): End => ({ id, kind });

/** A PRD end is a list item when the PRD has an item with that ID, and a section otherwise. */
const prdEnd = (graph: Graph, id: string): End =>
  end(HashSet.has(graph.ends.item, id) ? "item" : "prd", id);

/** One relation from each task to each of `targets(task)`. */
const fromTasks =
  (
    kind: RelationKind,
    targets: (task: GraphTask) => ReadonlyArray<string>,
    to: (graph: Graph, id: string) => End,
  ): Extractor =>
  (graph) =>
    Array.flatMap(graph.tasks, (task) =>
      Array.map(targets(task), (target): Relation => ({
        from: end("task", task.id),
        kind,
        to: to(graph, target),
      })),
    );

const fromSections =
  (
    kind: RelationKind,
    targets: (section: GraphSection) => ReadonlyArray<string>,
    to: (graph: Graph, id: string) => End,
  ): Extractor =>
  (graph) =>
    Array.flatMap(graph.sections, (section) =>
      Array.map(targets(section), (target): Relation => ({
        from: end("spec", section.id),
        kind,
        to: to(graph, target),
      })),
    );

const taskEnd = (_: Graph, id: string) => end("task", id);
const specEnd = (_: Graph, id: string) => end("spec", id);

/** One extractor per kind, so a kind added to the contract fails to compile until it has one. */
const extractors: Record.ReadonlyRecord<RelationKind, Extractor> = {
  builds: fromTasks("builds", (task) => task.specSections, specEnd),
  builtOn: fromTasks("builtOn", (task) => Option.toArray(Option.fromNullOr(task.parent)), taskEnd),
  dependsOn: fromSections("dependsOn", (section) => section.dependsOn, specEnd),
  implements: fromSections("implements", (section) => section.implements, prdEnd),
  names: fromTasks("names", (task) => task.prdSections, prdEnd),
  needs: fromTasks("needs", (task) => task.dependsOn, taskEnd),
  orderedAfter: fromTasks(
    "orderedAfter",
    (task) => Array.map(task.orderedAfter, ({ task: after }) => after),
    taskEnd,
  ),
  proves: (graph) =>
    Array.map(graph.proofs, ({ statement, test }): Relation => ({
      from: end("test", test),
      kind: "proves",
      to: end("statement", statement),
    })),
};

const isSpecSectionId = Schema.is(SpecSectionId);
const isPrdSectionId = Schema.is(PrdSectionId);

/** The values a section's own key lines list under `key`; a trace's keys also hold what the headings above list. */
const ownValuesOf = (body: ReadonlyArray<string>, key: string): ReadonlyArray<string> =>
  Array.flatMap(keyEntriesOf(body), ([name, values]) => (name === key ? values : []));

/**
 * The spec sections of `spec.md` with their own `Implements` and `Depends on`. It reads headings
 * and key lines line by line, as `sectionsOf` does, but skips the Markdown parse `sectionsOf`
 * makes to find human markers, which the index does not read: on this repository's spec that parse
 * is most of the time it takes to build the index from a trace.
 */
const specSectionsOf = (markdown: string): ReadonlyArray<GraphSection> => {
  const lines = linesOf(markdown);
  const starts = Array.getSomes(
    Array.map(headingsOf(lines), (found, at) => Option.map(found, (heading) => ({ at, heading }))),
  );
  const ends = Array.append(
    Array.map(Array.drop(starts, 1), ({ at }) => at),
    Array.length(lines),
  );
  return Array.filterMap(Array.zip(starts, ends), ([{ at, heading }, stop]) =>
    Option.match(Option.filter(heading.id, isSpecSectionId), {
      onNone: () => Result.failVoid,
      onSome: (id) => {
        const body = Array.take(Array.drop(lines, at + 1), stop - at - 1);
        return Result.succeed({
          dependsOn: Array.filter(ownValuesOf(body, "Depends on"), isSpecSectionId),
          id,
          implements: Array.filter(ownValuesOf(body, "Implements"), isPrdSectionId),
        });
      },
    }),
  );
};

const graphOf = (source: RelationSource): Graph => {
  if ("tasks" in source) {
    return {
      ends: {
        item: HashSet.empty(),
        prd: HashSet.empty(),
        spec: HashSet.empty(),
        statement: HashSet.empty(),
        task: HashSet.fromIterable(Array.map(source.tasks, ({ id }) => id)),
        test: HashSet.empty(),
      },
      proofs: [],
      sections: [],
      tasks: Array.map(source.tasks, (task) => ({
        dependsOn: task.dependsOn,
        id: task.id,
        orderedAfter: [],
        parent: task.parent,
        prdSections: [],
        specSections: [],
      })),
    };
  }
  if ("trace" in source) {
    const { prd, spec, tasks } = source.trace;
    const proofs = Array.flatMap(prd.statements, (statement) =>
      Array.map(statement.provedBy, (test) => ({ statement: statement.id, test })),
    );
    // A trace's keys also hold what the sections above list, so the sections are read again from
    // the spec's text, as `spec.json` is written.
    const sections = specSectionsOf(spec.markdown);
    return {
      ends: {
        item: HashSet.fromIterable(Array.map(prd.items, ({ id }) => id)),
        prd: HashSet.fromIterable(Array.map(prd.sections, ({ id }) => id)),
        spec: HashSet.fromIterable(Array.map(sections, ({ id }) => id)),
        statement: HashSet.fromIterable(Array.map(prd.statements, ({ id }) => id)),
        task: HashSet.fromIterable(Array.map(tasks, ({ id }) => id)),
        test: HashSet.fromIterable(Array.map(proofs, ({ test }) => test)),
      },
      proofs,
      sections,
      tasks,
    };
  }
  const { manifest, prd, specIndex } = source;
  const prdSections = sectionsOf(prd);
  const items = itemsOf(prd, prdSections);
  const tests = Array.flatMap(specIndex.sections, (section) => section.tests);
  return {
    ends: {
      item: HashSet.fromIterable(Array.flatMapNullishOr(items, ({ id }) => id)),
      prd: HashSet.fromIterable(Array.flatMapNullishOr(prdSections, ({ id }) => id)),
      spec: HashSet.fromIterable(Array.map(specIndex.sections, ({ id }) => id)),
      statement: HashSet.fromIterable(
        Array.flatMapNullishOr(statementsOf(prd, prdSections, items), ({ id }) => id),
      ),
      task: HashSet.fromIterable(Array.map(manifest.tasks, ({ id }) => id)),
      test: HashSet.fromIterable(Array.map(tests, ({ id }) => id)),
    },
    proofs: Array.flatMap(tests, (test) =>
      Array.map(test.proves, (statement) => ({ statement, test: test.id })),
    ),
    sections: specIndex.sections,
    tasks: manifest.tasks,
  };
};

const keyOf = (kind: RelationKind, id: string) => `${kind} ${id}`;

const sameRelation = (self: Relation, that: Relation) =>
  self.kind === that.kind &&
  self.from.kind === that.from.kind &&
  self.from.id === that.from.id &&
  self.to.kind === that.to.kind &&
  self.to.id === that.to.id;

const FINISHED: ReadonlyArray<TaskStatus> = ["done", "landed"];
const isUnfinished = (status: TaskStatus) => !Array.contains(FINISHED, status);

/**
 * Everything reachable from `start` along `next`, without `start` unless a cycle leads back to
 * it. Each step goes one edge further than the last, so the depth is at most the number of tasks.
 */
const reachOf = (
  start: TaskId,
  next: (task: TaskId) => ReadonlyArray<TaskId>,
): HashSet.HashSet<TaskId> => {
  const step = (
    frontier: ReadonlyArray<TaskId>,
    seen: HashSet.HashSet<TaskId>,
  ): HashSet.HashSet<TaskId> => {
    const fresh = Array.dedupe(
      Array.filter(Array.flatMap(frontier, next), (task) => !HashSet.has(seen, task)),
    );
    return Array.isReadonlyArrayEmpty(fresh)
      ? seen
      : step(fresh, HashSet.union(seen, HashSet.fromIterable(fresh)));
  };
  return step([start], HashSet.empty());
};

/** What `reachOf` gave for `task`, or nothing for a task the index does not hold. */
const reached = (reach: Record.ReadonlyRecord<TaskId, HashSet.HashSet<TaskId>>, task: TaskId) =>
  Option.getOrElse(Record.get(reach, task), () => HashSet.empty<TaskId>());

/**
 * Builds the relation index from `source` (see `spec.status.relation-index`). It is pure and
 * reads nothing but its argument; callers build it again when the source changes and memoise it on
 * the source's identity.
 */
export const indexOf = (source: RelationSource): RelationIndex => {
  const graph = graphOf(source);
  const exists = ({ id, kind }: End) => HashSet.has(graph.ends[kind], id);
  const [relations, dangling] = Array.partition(
    Array.dedupeWith(
      Array.flatMap(Record.values(extractors), (extract) => extract(graph)),
      sameRelation,
    ),
    (relation) =>
      exists(relation.from) && exists(relation.to)
        ? Result.succeed(relation)
        : Result.fail(relation),
  );
  const outOf = Array.groupBy(relations, (relation) => keyOf(relation.kind, relation.from.id));
  const intoOf = Array.groupBy(relations, (relation) => keyOf(relation.kind, relation.to.id));
  const out = (id: string, kind: RelationKind): ReadonlyArray<Relation> =>
    Option.getOrElse(Record.get(outOf, keyOf(kind, id)), () => []);
  const into = (id: string, kind: RelationKind): ReadonlyArray<Relation> =>
    Option.getOrElse(Record.get(intoOf, keyOf(kind, id)), () => []);

  const tasks = Array.sort(Array.dedupe(Array.map(graph.tasks, ({ id }) => id)), TaskIdOrder);
  const taskIds: Record.ReadonlyRecord<string, TaskId> = Record.fromIterableWith(tasks, (task) => [
    task,
    task,
  ]);
  const taskAt = (id: string) => Record.get(taskIds, id);
  const needsOf = Record.fromIterableWith(tasks, (task) => [
    task,
    Array.dedupe(Array.getSomes(Array.map(out(task, "needs"), ({ to }) => taskAt(to.id)))),
  ]);
  const neededByOf = Record.fromIterableWith(tasks, (task) => [
    task,
    Array.dedupe(Array.getSomes(Array.map(into(task, "needs"), ({ from }) => taskAt(from.id)))),
  ]);
  const needs = (task: TaskId) => Option.getOrElse(Record.get(needsOf, task), () => []);
  const neededBy = (task: TaskId) => Option.getOrElse(Record.get(neededByOf, task), () => []);

  const needsReach = Record.fromIterableWith(tasks, (task) => [task, reachOf(task, needs)]);
  const neededByReach = Record.fromIterableWith(tasks, (task) => [task, reachOf(task, neededBy)]);
  const inCycle = (task: TaskId) => HashSet.has(reached(needsReach, task), task);

  const cycles = Array.filterMap(tasks, (task) => {
    const strong = Array.filter(
      tasks,
      (other) =>
        HashSet.has(reached(needsReach, task), other) &&
        HashSet.has(reached(needsReach, other), task),
    );
    return inCycle(task) && Option.contains(Array.head(strong), task)
      ? Result.succeed(strong)
      : Result.failVoid;
  });

  // Kahn's algorithm over the tasks outside a cycle: the next task is the first in `TaskIdOrder`
  // whose every need is placed or in a cycle. What is left has no cycle, so every task is placed.
  const place = (
    placed: ReadonlyArray<TaskId>,
    done: HashSet.HashSet<TaskId>,
    rest: ReadonlyArray<TaskId>,
  ): ReadonlyArray<TaskId> =>
    Option.match(
      Array.findFirst(rest, (task) =>
        Array.every(needs(task), (need) => HashSet.has(done, need) || inCycle(need)),
      ),
      {
        onNone: () => placed,
        onSome: (next) =>
          place(
            Array.append(placed, next),
            HashSet.add(done, next),
            Array.filter(rest, (task) => task !== next),
          ),
      },
    );
  const order = place(
    [],
    HashSet.empty(),
    Array.filter(tasks, (task) => !inCycle(task)),
  );

  const inOrder = (reach: HashSet.HashSet<TaskId>, self: TaskId) =>
    Array.appendAll(
      Array.filter(order, (task) => HashSet.has(reach, task)),
      Array.filter(tasks, (task) => task !== self && inCycle(task) && HashSet.has(reach, task)),
    );
  const waitsOn = (task: TaskId, statusOf: StatusOf) =>
    Array.sort(
      Array.filter(needs(task), (need) => isUnfinished(statusOf(need))),
      TaskIdOrder,
    );

  return {
    buildOrder: (only) =>
      Predicate.isUndefined(only)
        ? order
        : pipe(HashSet.fromIterable(only), (kept) =>
            Array.filter(order, (task) => HashSet.has(kept, task)),
          ),
    canRunTogether: (a, b) =>
      !HashSet.has(reached(needsReach, a), b) && !HashSet.has(reached(needsReach, b), a),
    canStart: (task, statusOf) =>
      Option.isSome(taskAt(task)) &&
      statusOf(task) === "pending" &&
      Array.isReadonlyArrayEmpty(waitsOn(task, statusOf)),
    cycles,
    dangling,
    into,
    neededByAll: (task) => inOrder(reached(neededByReach, task), task),
    needsAll: (task) => inOrder(reached(needsReach, task), task),
    out,
    waitedOnBy: (task, statusOf) =>
      Array.sort(
        Array.filter(neededBy(task), (other) => isUnfinished(statusOf(other))),
        TaskIdOrder,
      ),
    waitsOn,
  };
};
