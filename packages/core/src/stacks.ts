import { ManifestTask, TaskId } from "@cairn/contract";
import {
  Array,
  HashSet,
  MutableHashMap,
  MutableHashSet,
  Number,
  Option,
  Order,
  Record,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";

/** The part of a task the stacks read. A `TraceTask` fits. */
export const StackTask = ManifestTask.mapFields(
  Struct.pick(["dependsOn", "id", "parent", "specSections"]),
);
export type StackTask = typeof StackTask.Type;

const Place = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Where a task sits in the stacks area. Both are 1-based; row 1 is the bottom. */
export const StackPosition = Schema.Struct({ column: Place, row: Place });
export type StackPosition = typeof StackPosition.Type;

/**
 * One stack: a root task that starts from the base branch and every task built on it through
 * parent branches. `cells` places each of its tasks inside its box, row 1 at the bottom. `level`
 * is the row of boxes it sits in, level 1 over the base branch.
 */
export const Stack = Schema.Struct({
  area: Schema.Option(Schema.String),
  cells: Schema.Record(TaskId, StackPosition),
  level: Place,
  number: Place,
  root: TaskId,
});
export type Stack = typeof Stack.Type;

/** Orders task ids by their number, so `t2` comes before `t10`. */
export const TaskIdOrder: Order.Order<TaskId> = Order.make((self, that) =>
  String.localeCompare(that, ["en"], { numeric: true })(self),
);

/** `Stack N · area`, or `Stack N` for a root with no spec section: the diagram's subgraph label. */
export const labelOf = (stack: Stack): string =>
  Option.match(stack.area, {
    onNone: () => `Stack ${stack.number}`,
    onSome: (area) => `Stack ${stack.number} · ${area}`,
  });

/** The second segment of a task's first spec section: `contract` for `spec.contract.trace`. */
const areaOf = (task: StackTask): Option.Option<string> =>
  Option.flatMap(Array.head(task.specSections), (section) =>
    Array.get(String.split(section, "."), 1),
  );

/**
 * Groups the tasks into the stacks of the plan's stack diagram, in number order.
 *
 * A root is a task whose parent is `null`, names no task, or would close a cycle of parents; in a
 * cycle, the task with the lowest id is the root. Every other task belongs to its parent's stack.
 * Stacks are numbered from 1 in `TaskIdOrder` of their roots.
 *
 * Inside a stack a task's row is its depth, 1 for the root. Columns are numbered depth first: the
 * root is in column 1, the first child by id continues its parent's column, and each other child,
 * in id order, starts the column after the last one used by its elder siblings and everything
 * built on them. So the columns under any task are one unbroken run.
 *
 * A stack waits on another when one of its tasks depends on a task in the other. Its level is 1
 * when it waits on nothing, otherwise one more than the highest level among the stacks it waits
 * on. A dependency that names no task, or that would close a cycle between stacks, is ignored.
 */
export const stacksOf = (tasks: ReadonlyArray<StackTask>): ReadonlyArray<Stack> => {
  const sorted = Array.dedupeWith(
    Array.sortWith(tasks, (task) => task.id, TaskIdOrder),
    (self: StackTask, that: StackTask) => self.id === that.id,
  );
  const byId = Record.fromIterableWith(sorted, (task) => [task.id, task]);
  const namedParentOf = (task: StackTask): Option.Option<StackTask> =>
    pipe(
      Option.fromNullOr(task.parent),
      Option.filter((parent) => parent !== task.id),
      Option.flatMap((parent) => Record.get(byId, parent)),
    );

  // Walking up from a task either ends at a task with no named parent or comes back to a task
  // already on the path. The tasks from that one on are a cycle of parents.
  const cycleAbove = (task: StackTask, path: ReadonlyArray<TaskId>): ReadonlyArray<TaskId> =>
    Option.match(namedParentOf(task), {
      onNone: () => [],
      onSome: (parent) =>
        Option.match(
          Array.findFirstIndex(path, (id) => id === parent.id),
          {
            onNone: () => cycleAbove(parent, Array.append(path, parent.id)),
            onSome: (start) => Array.drop(path, start),
          },
        ),
    });
  const cut = HashSet.fromIterable(
    Array.getSomes(
      Array.map(sorted, (task) => Array.head(Array.sort(cycleAbove(task, [task.id]), TaskIdOrder))),
    ),
  );
  const parentOf = (task: StackTask): Option.Option<StackTask> =>
    HashSet.has(cut, task.id) ? Option.none() : namedParentOf(task);

  /** The task and its parents, root first. Parents no longer form a cycle, so this ends. */
  const lineageOf = (task: StackTask): Array.NonEmptyReadonlyArray<StackTask> =>
    Option.match(parentOf(task), {
      onNone: () => Array.make(task),
      onSome: (parent) => Array.append(lineageOf(parent), task),
    });

  // `sorted` is in id order, so each group of children is too.
  const childrenOf = Record.map(
    Array.groupBy(
      Array.getSomes(
        Array.map(sorted, (task) => Option.map(parentOf(task), (parent) => ({ parent, task }))),
      ),
      ({ parent }) => parent.id,
    ),
    Array.map(({ task }) => task),
  );

  /**
   * Places a task in `column` and its children depth first: the first child continues the column
   * and each other child starts after the last column its elder siblings used. `next` is the
   * first column the subtree left free. Parents no longer form a cycle, so this ends.
   */
  const placeFrom = (
    task: StackTask,
    column: number,
  ): {
    readonly columns: ReadonlyArray<readonly [TaskId, number]>;
    readonly next: number;
  } =>
    Array.match(
      Option.getOrElse(Record.get(childrenOf, task.id), () => Array.empty<StackTask>()),
      {
        onEmpty: () => ({ columns: [[task.id, column]], next: column + 1 }),
        onNonEmpty: (children) =>
          Array.reduce(
            children,
            {
              columns: [[task.id, column]] as ReadonlyArray<readonly [TaskId, number]>,
              next: column,
            },
            (placed, child) => {
              const below = placeFrom(child, placed.next);
              return {
                columns: Array.appendAll(placed.columns, below.columns),
                next: below.next,
              };
            },
          ),
      },
    );

  const roots = Array.filter(sorted, (task) => Option.isNone(parentOf(task)));
  const members = Array.groupBy(sorted, (task) => Array.headNonEmpty(lineageOf(task)).id);
  const rootIdOf = Record.fromIterableWith(sorted, (task) => [
    task.id,
    Array.headNonEmpty(lineageOf(task)).id,
  ]);

  /** The roots of the stacks a stack waits on, without its own. */
  const waitsOn = (root: TaskId): ReadonlyArray<TaskId> =>
    pipe(
      Option.getOrElse(Record.get(members, root), () => Array.empty<StackTask>()),
      Array.flatMap((task) => task.dependsOn),
      Array.map((dependency) => Record.get(rootIdOf, dependency)),
      Array.getSomes,
      Array.filter((other) => other !== root),
      Array.dedupe,
    );

  // A memo and a cycle guard for the recursion below. Both are local and never escape. Stacks are
  // visited in id order of their roots, so which edge of a cycle is ignored does not depend on the input order.
  const levels = MutableHashMap.empty<TaskId, number>();
  const visiting = MutableHashSet.empty<TaskId>();
  const levelOf = (root: TaskId): number =>
    Option.getOrElse(MutableHashMap.get(levels, root), () => {
      MutableHashSet.add(visiting, root);
      const level = Array.reduce(
        Array.filter(waitsOn(root), (other) => !MutableHashSet.has(visiting, other)),
        1,
        (highest, other) => Number.max(highest, levelOf(other) + 1),
      );
      MutableHashSet.remove(visiting, root);
      MutableHashMap.set(levels, root, level);
      return level;
    });

  return Array.map(roots, (root, index) => {
    const own = Option.getOrElse(Record.get(members, root.id), () => Array.empty<StackTask>());
    const columns = Record.fromEntries(placeFrom(root, 1).columns);
    return {
      area: areaOf(root),
      cells: Record.fromIterableWith(own, (task) => [
        task.id,
        {
          // Every member is placed from its root, so the fallback never applies.
          column: Option.getOrElse(Record.get(columns, task.id), () => 1),
          row: lineageOf(task).length,
        },
      ]),
      level: levelOf(root.id),
      number: index + 1,
      root: root.id,
    };
  });
};
