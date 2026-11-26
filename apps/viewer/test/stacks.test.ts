import { Manifest, TaskId } from "@cairn/contract";
import { StackTask, TaskIdOrder, labelOf, stacksOf, type Stack } from "@cairn/core/stacks";
import { expect, it } from "@effect/vitest";
import { Array, Hash, HashSet, Number, Option, Order, Record, Schema, String, pipe } from "effect";

import manifestJson from "../../../.cairn/manifest.json" with { type: "json" };
import specMarkdown from "../../../.cairn/spec.md?raw";
import { boxOf } from "../src/boxes.ts";

const id = (n: number): TaskId => TaskId.make(`t${n}`);
const ghost = TaskId.make("ghost");

/** A stable, non-negative number for a string, to point generated ids at a small pool. */
const hash = (text: string): number => Hash.string(text) >>> 0;

const pick = <A>(items: ReadonlyArray<A>, seed: string): Option.Option<A> =>
  Array.isReadonlyArrayNonEmpty(items)
    ? Array.get(items, hash(seed) % items.length)
    : Option.none();

const Plan = Schema.Array(StackTask).check(Schema.isMaxLength(16));

/**
 * Generated ids almost never refer to each other, so rename the tasks `t1`, `t2`, ... and point
 * each parent and dependency at one of them, or at a task that does not exist. Parents can form
 * cycles, and so can the stacks.
 */
const planOf = (generated: typeof Plan.Type): ReadonlyArray<StackTask> => {
  const pool = Array.append(
    Array.map(generated, (_, index) => id(index + 1)),
    ghost,
  );
  const relink = (seed: string): TaskId => Option.getOrElse(pick(pool, seed), () => ghost);
  return Array.map(generated, (task, index) => ({
    dependsOn: Array.map(task.dependsOn, relink),
    id: id(index + 1),
    parent: Option.getOrNull(Option.map(Option.fromNullOr(task.parent), relink)),
    specSections: task.specSections,
  }));
};

/** Each task's stack, by task id. */
const stackByTask = (stacks: ReadonlyArray<Stack>): Record.ReadonlyRecord<TaskId, Stack> =>
  Record.fromIterableWith(
    Array.flatMap(stacks, (stack) =>
      Array.map(Record.keys(stack.cells), (task) => ({ stack, task })),
    ),
    ({ stack, task }) => [task, stack],
  );

const stackOf = (stacks: ReadonlyArray<Stack>, taskId: TaskId): Stack =>
  Option.getOrThrow(Record.get(stackByTask(stacks), taskId));

const rowOf = (stack: Stack, taskId: TaskId): number =>
  Option.getOrThrow(Record.get(stack.cells, taskId)).row;

const columnOf = (stack: Stack, taskId: TaskId): number =>
  Option.getOrThrow(Record.get(stack.cells, taskId)).column;

const sortedIds = (ids: ReadonlyArray<TaskId>): ReadonlyArray<TaskId> =>
  Array.sort(ids, TaskIdOrder);

/** Whether walking up parents from `from` comes back to `to`. */
const parentsReach = (tasks: ReadonlyArray<StackTask>, from: TaskId, to: TaskId): boolean => {
  const byId = Record.fromIterableWith(tasks, (task) => [task.id, task]);
  const walk = (at: TaskId, seen: HashSet.HashSet<TaskId>): boolean =>
    at === to ||
    (!HashSet.has(seen, at) &&
      pipe(
        Record.get(byId, at),
        Option.flatMap((task) => Option.fromNullOr(task.parent)),
        Option.exists((parent) => walk(parent, HashSet.add(seen, at))),
      ));
  return walk(from, HashSet.empty());
};

it.prop("every task is in exactly one stack", [Plan], ([generated]) => {
  const tasks = planOf(generated);
  const placed = Array.flatMap(stacksOf(tasks), (stack) => Record.keys(stack.cells));
  expect(sortedIds(placed)).toEqual(sortedIds(Array.map(tasks, (task) => task.id)));
});

it.prop(
  "a child shares its parent's stack one row above it, and a root's parent is null, unknown or on a cycle",
  [Plan],
  ([generated]) => {
    const tasks = planOf(generated);
    const stacks = stacksOf(tasks);
    const ids = HashSet.fromIterable(Array.map(tasks, (task) => task.id));
    Array.forEach(tasks, (task) => {
      const stack = stackOf(stacks, task.id);
      if (stack.root === task.id) {
        // A cycle of parents is cut at its lowest id.
        expect(
          Option.match(Option.fromNullOr(task.parent), {
            onNone: () => true,
            onSome: (parent) =>
              !HashSet.has(ids, parent) ||
              (parentsReach(tasks, parent, task.id) &&
                Array.every(
                  Array.filter(
                    tasks,
                    (other) =>
                      parentsReach(tasks, task.id, other.id) &&
                      parentsReach(tasks, other.id, task.id),
                  ),
                  (other) => TaskIdOrder(task.id, other.id) <= 0,
                )),
          }),
        ).toBe(true);
      } else {
        const parent = Option.getOrThrow(Option.fromNullOr(task.parent));
        expect(stackOf(stacks, parent).number).toBe(stack.number);
        expect(rowOf(stack, task.id)).toBe(rowOf(stack, parent) + 1);
      }
    });
  },
);

it.prop(
  "no two tasks in a box share a cell, and the root sits at the bottom",
  [Plan],
  ([generated]) => {
    Array.forEach(stacksOf(planOf(generated)), (stack) => {
      const cells = Array.map(Record.values(stack.cells), (cell) => `${cell.column}:${cell.row}`);
      expect(Array.dedupe(cells)).toEqual(cells);
      expect(rowOf(stack, stack.root)).toBe(1);
    });
  },
);

it.prop(
  "the first child by id continues its parent's column and every other child starts a new one",
  [Plan],
  ([generated]) => {
    const tasks = planOf(generated);
    const stacks = stacksOf(tasks);
    const children = Array.filter(tasks, (task) => stackOf(stacks, task.id).root !== task.id);
    Array.forEach(children, (child) => {
      const stack = stackOf(stacks, child.id);
      const parent = Option.getOrThrow(Option.fromNullOr(child.parent));
      const first = Array.head(
        Array.sort(
          Array.map(
            Array.filter(children, (other) => other.parent === parent),
            (other) => other.id,
          ),
          TaskIdOrder,
        ),
      );
      expect(columnOf(stack, child.id) === columnOf(stack, parent)).toBe(
        Option.contains(first, child.id),
      );
    });
  },
);

it.prop("a stack's level is above every stack it waits on, cycles aside", [Plan], ([generated]) => {
  const tasks = planOf(generated);
  const stacks = stacksOf(tasks);
  const byTask = stackByTask(stacks);
  const waitsOn = (stack: Stack): ReadonlyArray<Stack> =>
    pipe(
      Array.filter(tasks, (task) => Record.has(stack.cells, task.id)),
      Array.flatMap((task) => task.dependsOn),
      Array.map((dependency) => Record.get(byTask, dependency)),
      Array.getSomes,
      Array.filter((other) => other.number !== stack.number),
    );
  const reaches = (from: Stack, to: Stack, seen: HashSet.HashSet<number>): boolean =>
    from.number === to.number ||
    (!HashSet.has(seen, from.number) &&
      Array.some(waitsOn(from), (next) => reaches(next, to, HashSet.add(seen, from.number))));
  Array.forEach(stacks, (stack) => {
    const waited = waitsOn(stack);
    Array.forEach(
      Array.filter(waited, (other) => !reaches(other, stack, HashSet.empty())),
      (other) => expect(stack.level).toBeGreaterThan(other.level),
    );
    // Ignoring an edge of a cycle can only lower a level, never raise it.
    expect(stack.level).toBeLessThanOrEqual(
      Array.reduce(waited, 1, (highest, other) => Number.max(highest, other.level + 1)),
    );
  });
});

it.prop("stacks are numbered from 1 in the order of their roots' ids", [Plan], ([generated]) => {
  const stacks = stacksOf(planOf(generated));
  expect(Array.map(stacks, (stack) => stack.number)).toEqual(
    Array.map(stacks, (_, index) => index + 1),
  );
  const roots = Array.map(stacks, (stack) => stack.root);
  expect(roots).toEqual(sortedIds(roots));
});

it.prop(
  "the area is the second segment of the root's first spec section",
  [Plan],
  ([generated]) => {
    const tasks = planOf(generated);
    Array.forEach(stacksOf(tasks), (stack) => {
      const root = Option.getOrThrow(Array.findFirst(tasks, (task) => task.id === stack.root));
      expect(stack.area).toEqual(
        Array.get(String.split(Array.headNonEmpty(root.specSections), "."), 1),
      );
    });
  },
);

it.prop(
  "the input order does not change the result",
  [Plan, Schema.Array(Schema.Int)],
  ([generated, keys]) => {
    const tasks = planOf(generated);
    // Each task gets a generated sort key, so the input arrives in an arbitrary order.
    type Keyed = { readonly key: number; readonly task: StackTask };
    const shuffled = Array.map(
      Array.sortWith(
        Array.map(tasks, (task, index): Keyed => ({
          key: Option.getOrElse(Array.get(keys, index), () => index),
          task,
        })),
        (keyed: Keyed) => keyed.key,
        Order.Number,
      ),
      (keyed) => keyed.task,
    );
    expect(stacksOf(shuffled)).toEqual(stacksOf(tasks));
    expect(stacksOf(Array.reverse(tasks))).toEqual(stacksOf(tasks));
  },
);

const spec = (section: string) => Schema.decodeSync(StackTask.fields.specSections)([section]);
const task = (n: number, parent: number | null, dependsOn: ReadonlyArray<number>): StackTask => ({
  dependsOn: Array.map(dependsOn, id),
  id: id(n),
  parent: Option.getOrNull(Option.map(Option.fromNullOr(parent), id)),
  specSections: spec("spec.viewer.stacks"),
});

it("a fork puts the first child by number in its parent's column and the others beside it", () => {
  const [stack] = stacksOf([task(1, null, []), task(10, 1, [1]), task(2, 1, [1]), task(3, 2, [2])]);
  expect(stack).toEqual({
    area: Option.some("viewer"),
    cells: {
      t1: { column: 1, row: 1 },
      t10: { column: 2, row: 2 },
      t2: { column: 1, row: 2 },
      t3: { column: 1, row: 3 },
    },
    level: 1,
    number: 1,
    root: id(1),
  });
});

it("columns are numbered depth first, so a fork's children sit in one unbroken run under it", () => {
  // t1 forks into t2 and t5; t2 forks into t3 and t9. By the id of a column's first task, t9 would
  // come after t5 and cut t2's columns in two.
  const [stack] = stacksOf([
    task(1, null, []),
    task(2, 1, []),
    task(5, 1, []),
    task(3, 2, []),
    task(9, 2, []),
    task(6, 9, []),
  ]);
  expect(Option.map(Option.fromUndefinedOr(stack), (found) => found.cells)).toEqual(
    Option.some({
      t1: { column: 1, row: 1 },
      t2: { column: 1, row: 2 },
      t3: { column: 1, row: 3 },
      t5: { column: 3, row: 2 },
      t6: { column: 2, row: 4 },
      t9: { column: 2, row: 3 },
    }),
  );
});

it("a stack that waits on two others sits one level above the higher of them", () => {
  const stacks = stacksOf([
    task(1, null, []),
    task(2, null, [1]),
    task(3, null, []),
    task(4, 3, [3, 2]),
    task(5, null, [99]),
  ]);
  expect(Array.map(stacks, (stack) => [labelOf(stack), stack.level])).toEqual([
    ["Stack 1 · viewer", 1],
    ["Stack 2 · viewer", 2],
    ["Stack 3 · viewer", 3],
    ["Stack 4 · viewer", 1],
  ]);
});

it("a cycle of parents is cut at its lowest id, and a cycle of stacks is ignored", () => {
  const stacks = stacksOf([task(1, 2, [3]), task(2, 1, [1]), task(3, null, [2])]);
  expect(Array.map(stacks, (stack) => [stack.root, stack.cells, stack.level])).toEqual([
    [id(1), { t1: { column: 1, row: 1 }, t2: { column: 1, row: 2 } }, 2],
    [id(3), { t3: { column: 1, row: 1 } }, 1],
  ]);
});

it("an empty plan has no stacks", () => {
  expect(stacksOf([])).toEqual([]);
});

/** The text of the stack diagram in spec.planning.stack-order. */
const diagramOf = (markdown: string): string => {
  const [, afterHeading] = String.split(markdown, "{#spec.planning.stack-order}");
  const [, afterFence] = String.split(
    Option.getOrThrow(Option.fromUndefinedOr(afterHeading)),
    "```mermaid\n",
  );
  const [diagram] = String.split(Option.getOrThrow(Option.fromUndefinedOr(afterFence)), "```");
  return Option.getOrThrow(Option.fromUndefinedOr(diagram));
};

/** The solid arrows between tasks in the diagram, as `t45 --> t46`, without those from `main`. */
const keyId = (key: string): string => Option.getOrThrow(Array.last(String.split(key, ":")));

const diagramArrows = (markdown: string): ReadonlyArray<string> =>
  Array.sort(
    Array.getSomes(
      Array.map(String.split(diagramOf(markdown), "\n"), (line) =>
        Option.map(String.match(/^\s*(t\d+ --> t\d+)$/u)(line), (match) =>
          Option.getOrThrow(Array.get(match, 1)),
        ),
      ),
    ),
    Order.String,
  );

/** The subgraph labels of the stack diagram in spec.planning.stack-order, each with its tasks. */
const diagramStacks = (
  markdown: string,
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
  const diagram = diagramOf(markdown);
  const [, stacks] = Array.mapAccum(
    String.split(diagram, "\n"),
    Option.none<readonly [string, ReadonlyArray<string>]>(),
    (open, line) => {
      const subgraph = String.match(/^\s*subgraph \w+\["(.+)"\]$/u)(line);
      const node = String.match(/^\s*(t\d+)\[/u)(line);
      const closed: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [];
      return Option.isSome(subgraph)
        ? [Option.map(Array.get(subgraph.value, 1), (label) => [label, []] as const), closed]
        : Option.isSome(node)
          ? [
              Option.map(
                open,
                ([label, ids]) =>
                  [
                    label,
                    Array.appendAll(ids, Array.fromOption(Array.get(node.value, 1))),
                  ] as const,
              ),
              closed,
            ]
          : String.trim(line) === "end"
            ? [Option.none(), Option.toArray(open)]
            : [open, closed];
    },
  );
  return Array.map(
    Array.flatten(stacks),
    ([label, ids]) => [label, Array.sort(ids, Order.String)] as const,
  );
};

it("the spec's stack diagram draws the stacks stacksOf finds in the manifest", () => {
  const manifest = Schema.decodeUnknownSync(Manifest)(manifestJson);
  const drawn = diagramStacks(specMarkdown);
  expect(Array.isReadonlyArrayNonEmpty(drawn)).toBe(true);
  expect(drawn).toEqual(
    Array.map(
      stacksOf(manifest.tasks),
      (stack) => [labelOf(stack), Array.sort(Record.keys(stack.cells), Order.String)] as const,
    ),
  );
});

it("the parent arrows of every box, unfolded, are the solid arrows between tasks in the diagram", () => {
  const manifest = Schema.decodeUnknownSync(Manifest)(manifestJson);
  const drawn = diagramArrows(specMarkdown);
  expect(Array.isReadonlyArrayNonEmpty(drawn)).toBe(true);
  const arrows = Array.flatMap(stacksOf(manifest.tasks), (stack) =>
    Array.map(
      boxOf(stack, manifest.tasks, true).arrows,
      (arrow) => `${keyId(arrow.source)} --> ${keyId(arrow.target)}`,
    ),
  );
  expect(Array.sort(arrows, Order.String)).toEqual(drawn);
});

it("lays out this repo's manifest", () => {
  const manifest = Schema.decodeUnknownSync(Manifest)(manifestJson);
  const stacks = stacksOf(manifest.tasks);
  // t6 is built on t9, so the stack starts at t9.
  const contract = stackOf(stacks, id(6));
  expect(contract.root).toBe(id(9));
  expect(contract.cells).toMatchObject({ t6: { column: 1, row: 2 }, t9: { column: 1, row: 1 } });
  // t10 needs t6, t8 and t9, so its stack sits above both of theirs.
  expect(stackOf(stacks, id(10)).level).toBeGreaterThan(contract.level);
  expect(stackOf(stacks, id(1)).level).toBe(1);
});
