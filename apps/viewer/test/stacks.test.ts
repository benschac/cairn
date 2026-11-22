import { Manifest, TaskId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Number, Option, Order, Record, Schema, pipe } from "effect";

import manifestJson from "../../../.cairn/manifest.json" with { type: "json" };
import { TaskIdOrder, stackLayoutOf, type StackLayout, type StackTask } from "../src/stacks.ts";

const id = (n: number): TaskId => TaskId.make(`t${n}`);
const root = (n: number, dependsOn: ReadonlyArray<number>): StackTask => ({
  dependsOn: Array.map(dependsOn, id),
  id: id(n),
  parent: null,
});
const child = (n: number, parent: number, dependsOn: ReadonlyArray<number>): StackTask => ({
  dependsOn: Array.map(dependsOn, id),
  id: id(n),
  parent: id(parent),
});

const Small = Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 }));
const Rows = Schema.Array(
  Schema.Struct({
    deps: Schema.Array(Small).check(Schema.isMaxLength(3)),
    forked: Schema.Boolean,
    parent: Small,
  }),
).check(Schema.isBetweenLength(1, 14));

/** A valid DAG: ids t1..tn in dependency order, and a parent is always one of the dependencies. */
const dagOf = (rows: typeof Rows.Type): ReadonlyArray<StackTask> =>
  Array.map(rows, (row, index) => {
    const maybeParent = pipe(
      Option.some(index),
      Option.filter((earlier) => earlier > 0 && row.forked),
      Option.map((earlier) => (row.parent % earlier) + 1),
    );
    const deps = index === 0 ? [] : Array.map(row.deps, (dep) => (dep % index) + 1);
    return {
      dependsOn: Array.map(Array.dedupe(Array.appendAll(deps, Option.toArray(maybeParent))), id),
      id: id(index + 1),
      parent: Option.getOrNull(Option.map(maybeParent, id)),
    };
  });

const at = (layout: StackLayout, taskId: TaskId) => Option.getOrThrow(Record.get(layout, taskId));

/** Each task that has a parent, with that parent's id. */
const childrenOf = <T extends StackTask>(tasks: ReadonlyArray<T>) =>
  Array.getSomes(
    Array.map(tasks, (task) =>
      Option.map(Option.fromNullOr(task.parent), (parent) => ({ parent, task })),
    ),
  );

/** Whether a task is the first child of its parent by id, so it continues the parent's column. */
const continuesParent = (tasks: ReadonlyArray<StackTask>, task: StackTask, parent: TaskId) =>
  Option.exists(
    Array.head(
      Array.sortWith(
        Array.filter(tasks, (other) => other.parent === parent),
        (other: StackTask) => other.id,
        TaskIdOrder,
      ),
    ),
    (first) => first.id === task.id,
  );

it.prop("every task has a position", [Rows], ([rows]) => {
  const tasks = dagOf(rows);
  expect(Array.sort(Record.keys(stackLayoutOf(tasks)), TaskIdOrder)).toEqual(
    Array.map(tasks, (t) => t.id),
  );
});

it.prop("every task sits above all of its dependencies", [Rows], ([rows]) => {
  const tasks = dagOf(rows);
  const layout = stackLayoutOf(tasks);
  Array.forEach(tasks, (t) => {
    Array.forEach(t.dependsOn, (dep) => {
      expect(at(layout, t.id).row).toBeGreaterThan(at(layout, dep).row);
    });
  });
});

it.prop("a task row is one more than its highest dependency", [Rows], ([rows]) => {
  const tasks = dagOf(rows);
  const layout = stackLayoutOf(tasks);
  Array.forEach(tasks, (t) => {
    const highest = Array.reduce(t.dependsOn, 0, (row, dep) =>
      Number.max(row, at(layout, dep).row),
    );
    expect(at(layout, t.id).row).toBe(highest + 1);
  });
});

it.prop(
  "a first child shares its parent's column and any other child does not",
  [Rows],
  ([rows]) => {
    const tasks = dagOf(rows);
    const layout = stackLayoutOf(tasks);
    Array.forEach(childrenOf(tasks), ({ parent, task }) => {
      expect(at(layout, task.id).column === at(layout, parent).column).toBe(
        continuesParent(tasks, task, parent),
      );
    });
  },
);

it.prop("no two tasks share a column and a row", [Rows], ([rows]) => {
  const cells = Array.map(Record.values(stackLayoutOf(dagOf(rows))), (p) => `${p.column}:${p.row}`);
  expect(Array.dedupe(cells)).toEqual(cells);
});

it.prop("columns are numbered from 1 in the order of their first task's id", [Rows], ([rows]) => {
  const tasks = dagOf(rows);
  const layout = stackLayoutOf(tasks);
  // `tasks` is in id order, so the first task seen in a column is its first by id.
  type First = { readonly column: number; readonly id: TaskId };
  const firsts = Array.sortWith(
    Array.dedupeWith(
      Array.map(tasks, (t): First => ({ column: at(layout, t.id).column, id: t.id })),
      (a: First, b: First) => a.column === b.column,
    ),
    (first: First) => first.column,
    Order.Number,
  );
  expect(Array.map(firsts, (first) => first.column)).toEqual(
    Array.makeBy(firsts.length, (index) => index + 1),
  );
  const ids = Array.map(firsts, (first) => first.id);
  expect(ids).toEqual(Array.sort(ids, TaskIdOrder));
});

it.prop(
  "the input order does not change the layout",
  [Rows, Schema.Array(Small)],
  ([rows, keys]) => {
    const tasks = dagOf(rows);
    // Each task gets a generated sort key, so the input arrives in an arbitrary order.
    type Keyed = { readonly key: number; readonly t: StackTask };
    const shuffled = Array.map(
      Array.sortWith(
        Array.map(tasks, (t, index): Keyed => ({
          key: Option.getOrElse(Array.get(keys, index), () => index),
          t,
        })),
        (keyed: Keyed) => keyed.key,
        Order.Number,
      ),
      (keyed) => keyed.t,
    );
    expect(stackLayoutOf(shuffled)).toEqual(stackLayoutOf(tasks));
    expect(stackLayoutOf(Array.reverse(tasks))).toEqual(stackLayoutOf(tasks));
  },
);

it.prop("TaskIdOrder orders task ids by their number", [Small, Small], ([a, b]) => {
  expect(TaskIdOrder(id(a), id(b))).toBe(Order.Number(a, b));
});

it("the first child by number continues the column and the others start new ones", () => {
  // t10 is listed before t2, but t2 is the first child by number.
  expect(
    stackLayoutOf([root(1, []), child(10, 1, [1]), child(2, 1, [1]), child(3, 1, [1])]),
  ).toEqual({
    t1: { column: 1, row: 1 },
    t10: { column: 3, row: 2 },
    t2: { column: 1, row: 2 },
    t3: { column: 2, row: 2 },
  });
});

it("a dependency on another column sits below the task that needs it", () => {
  expect(
    stackLayoutOf([root(1, []), root(2, []), child(3, 1, [1, 2]), child(4, 2, [2, 3])]),
  ).toEqual({
    t1: { column: 1, row: 1 },
    t2: { column: 2, row: 1 },
    t3: { column: 1, row: 2 },
    t4: { column: 2, row: 3 },
  });
});

it("ignores a dependency or parent that names no task, and a cycle", () => {
  const layout = stackLayoutOf([child(1, 99, [98]), root(2, [3]), child(3, 3, [2])]);
  expect(at(layout, id(1))).toEqual({ column: 1, row: 1 });
  expect(Record.size(layout)).toBe(3);
  const cells = Array.map(Record.values(layout), (p) => `${p.column}:${p.row}`);
  expect(Array.dedupe(cells)).toEqual(cells);
});

it("an empty trace has an empty layout", () => {
  expect(Record.isEmptyReadonlyRecord(stackLayoutOf([]))).toBe(true);
});

it("lays out this repo's manifest", () => {
  const manifest = Schema.decodeUnknownSync(Manifest)(manifestJson);
  const layout = stackLayoutOf(manifest.tasks);
  expect(Record.size(layout)).toBe(manifest.tasks.length);
  Array.forEach(manifest.tasks, (t) => {
    Array.forEach(t.dependsOn, (dep) => {
      expect(at(layout, t.id).row).toBeGreaterThan(at(layout, dep).row);
    });
  });
  Array.forEach(childrenOf(manifest.tasks), ({ parent, task }) => {
    expect(at(layout, task.id).column === at(layout, parent).column).toBe(
      continuesParent(manifest.tasks, task, parent),
    );
  });
  expect(at(layout, TaskId.make("t1"))).toEqual({ column: 1, row: 1 });
});
