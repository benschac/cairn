import { ManifestTask, type TaskId } from "@cairn/contract";
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

/** The part of a task the stack layout reads. A `TraceTask` fits. */
export const StackTask = ManifestTask.mapFields(Struct.pick(["dependsOn", "id", "parent"]));
export type StackTask = typeof StackTask.Type;

const Place = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Where a task sits in the stacks area. Both are 1-based; row 1 is the bottom. */
export const StackPosition = Schema.Struct({ column: Place, row: Place });
export type StackPosition = typeof StackPosition.Type;

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
export const stackLayoutOf = (tasks: ReadonlyArray<StackTask>): StackLayout => {
  const sorted = Array.sortWith(tasks, (task) => task.id, TaskIdOrder);
  const byId = Record.fromIterableWith(sorted, (task) => [task.id, task]);
  const parentOf = (task: StackTask): Option.Option<StackTask> =>
    pipe(
      Option.fromNullOr(task.parent),
      Option.filter((parent) => parent !== task.id),
      Option.flatMap((parent) => Record.get(byId, parent)),
    );
  const needsOf = (task: StackTask): ReadonlyArray<StackTask> =>
    Array.appendAll(
      Option.toArray(parentOf(task)),
      Array.getSomes(Array.map(task.dependsOn, (id) => Record.get(byId, id))),
    );

  // A memo and a cycle guard for the recursion below. Both are local and never escape.
  const rows = MutableHashMap.empty<TaskId, number>();
  const visiting = MutableHashSet.empty<TaskId>();
  const rowOf = (task: StackTask): number =>
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
  const headOf = (task: StackTask, seen: HashSet.HashSet<TaskId>): StackTask =>
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
    Array.map((head, index) => [head, index + 1] as const),
    Record.fromEntries,
  );

  return Record.fromIterableWith(Array.zip(sorted, heads), ([task, head]) => [
    task.id,
    // Every head has a column, so the fallback never applies.
    { column: Option.getOrElse(Record.get(columns, head), () => 1), row: rowOf(task) },
  ]);
};
