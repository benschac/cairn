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
  Tuple,
  pipe,
} from "effect";

/** The part of a task the stacks read. A `TraceTask` fits. */
export const StackTask = ManifestTask.mapFields(
  Struct.pick(["dependsOn", "id", "parent", "specSections"]),
);
export type StackTask = typeof StackTask.Type;

/** The links `stackLayoutOf` reads. */
export type LayoutTask = Pick<StackTask, "dependsOn" | "id" | "parent">;

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

/** Every task's position, by task id. */
export type StackLayout = Record.ReadonlyRecord<TaskId, StackPosition>;

/** A task's column in the layout, or column 1 for an id the layout does not place. */
export const columnOf =
  (layout: StackLayout) =>
  (taskId: TaskId): number =>
    Option.match(Record.get(layout, taskId), {
      onNone: () => 1,
      onSome: (position) => position.column,
    });

/** Orders task ids by their number, so `t2` comes before `t10`. */
export const TaskIdOrder: Order.Order<TaskId> = Order.make((self, that) =>
  String.localeCompare(that, ["en"], { numeric: true })(self),
);

/**
 * Gives every task a column and a row.
 *
 * Columns follow parent links. A task with no parent starts a column. At a fork the first child
 * by id continues its parent's column and every other child starts a new one. Columns are
 * numbered by the id of their first task.
 *
 * A task's row is its wave: 1 plus the highest row among its dependencies, or 1 with none.
 * Its parent counts as a dependency too, so a column never holds two tasks in one row. Ids that
 * name no task in the input are ignored, as is any link that would close a cycle.
 */
export const stackLayoutOf = (tasks: ReadonlyArray<LayoutTask>): StackLayout => {
  const sorted = Array.sortWith(tasks, (task) => task.id, TaskIdOrder);
  const byId = Record.fromIterableWith(sorted, (task) => [task.id, task]);
  const parentOf = (task: LayoutTask): Option.Option<LayoutTask> =>
    pipe(
      Option.fromNullOr(task.parent),
      Option.filter((parent) => parent !== task.id),
      Option.flatMap((parent) => Record.get(byId, parent)),
    );
  const needsOf = (task: LayoutTask): ReadonlyArray<LayoutTask> =>
    Array.appendAll(
      Array.fromOption(parentOf(task)),
      Array.getSomes(Array.map(task.dependsOn, (id) => Record.get(byId, id))),
    );

  // A memo and a cycle guard for the recursion below. Both are local and never escape.
  const rows = MutableHashMap.empty<TaskId, number>();
  const visiting = MutableHashSet.empty<TaskId>();
  const rowOf = (task: LayoutTask): number =>
    Option.getOrElse(MutableHashMap.get(rows, task.id), () => {
      MutableHashSet.add(visiting, task.id);
      const row = Array.reduce(
        Array.filter(
          needsOf(task),
          (need) => need.id !== task.id && !MutableHashSet.has(visiting, need.id),
        ),
        1,
        (highest, need) => Number.max(highest, rowOf(need) + 1),
      );
      MutableHashSet.remove(visiting, task.id);
      MutableHashMap.set(rows, task.id, row);
      return row;
    });

  // The first child by id continues its parent's column, so a column is a chain of those links.
  // Its head is the task that does not continue a parent. `sorted` is in id order, so the first
  // child in each group is the one that continues. Ids are compared as numbers, so a parent can
  // have a larger id than its child.
  const continuing = Record.map(
    Array.groupBy(
      Array.getSomes(
        Array.map(sorted, (task) => Option.map(parentOf(task), (parent) => ({ parent, task }))),
      ),
      ({ parent }) => parent.id,
    ),
    (children) => Array.headNonEmpty(children).task.id,
  );
  const headOf = (task: LayoutTask, seen: HashSet.HashSet<TaskId>): LayoutTask =>
    Option.match(
      Option.filter(
        parentOf(task),
        (parent) =>
          Option.contains(Record.get(continuing, parent.id), task.id) &&
          !HashSet.has(seen, parent.id),
      ),
      { onNone: () => task, onSome: (parent) => headOf(parent, HashSet.add(seen, task.id)) },
    );
  const heads = Array.map(sorted, (task) => headOf(task, HashSet.empty()).id);
  const columns = pipe(
    heads,
    Array.dedupe,
    (ids) => Array.sort(ids, TaskIdOrder),
    Array.map((head, index) => Tuple.make(head, index + 1)),
    Record.fromEntries,
  );

  return Record.fromIterableWith(Array.zip(sorted, heads), ([task, head]) => [
    task.id,
    // Every head has a column, so the fallback never applies.
    { column: Option.getOrElse(Record.get(columns, head), () => 1), row: rowOf(task) },
  ]);
};

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
 * Inside a stack a task's row is its depth, 1 for the root. The first child by id continues its
 * parent's column and every other child starts a new one; columns are numbered by the id of their
 * first task.
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

  // The first child by id continues its parent's column. `sorted` is in id order, so the first
  // child in each group is that one.
  const continuing = Record.map(
    Array.groupBy(
      Array.getSomes(
        Array.map(sorted, (task) => Option.map(parentOf(task), (parent) => ({ parent, task }))),
      ),
      ({ parent }) => parent.id,
    ),
    (children) => Array.headNonEmpty(children).task.id,
  );
  const headOf = (task: StackTask): StackTask =>
    Option.match(
      Option.filter(parentOf(task), (parent) =>
        Option.contains(Record.get(continuing, parent.id), task.id),
      ),
      { onNone: () => task, onSome: headOf },
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
    const columns = pipe(
      own,
      Array.map((task) => headOf(task).id),
      Array.dedupe,
      (heads) => Array.sort(heads, TaskIdOrder),
      Array.map((head, at) => Tuple.make(head, at + 1)),
      Record.fromEntries,
    );
    return {
      area: areaOf(root),
      cells: Record.fromIterableWith(own, (task) => [
        task.id,
        {
          // Every head has a column, so the fallback never applies.
          column: Option.getOrElse(Record.get(columns, headOf(task).id), () => 1),
          row: lineageOf(task).length,
        },
      ]),
      level: levelOf(root.id),
      number: index + 1,
      root: root.id,
    };
  });
};
