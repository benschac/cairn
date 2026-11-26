import { TaskId } from "@cairn/contract";
import { stacksOf, TaskIdOrder, type Stack } from "@cairn/core/stacks";
import { expect, it } from "@effect/vitest";
import { Array, Hash, HashSet, Number, Option, Order, Record, Schema, String, pipe } from "effect";

import {
  BoxTask,
  boxOf,
  endKeyInOf,
  endKeyOf,
  stackBoxesOf,
  trunkLabelOf,
  type Box,
} from "../src/boxes.ts";
import { demoTrace } from "../src/demo.ts";

const id = (n: number): TaskId => TaskId.make(`t${n}`);
const ghost = TaskId.make("ghost");

/** A stable, non-negative number for a string, to point generated ids at a small pool. */
const hash = (text: string): number => Hash.string(text) >>> 0;

const Plan = Schema.Array(BoxTask).check(Schema.isMaxLength(16));

/** How many of a plan's first tasks are done. */
const Finished = Schema.Int.check(Schema.isBetween({ maximum: 16, minimum: 0 }));

/**
 * Generated ids almost never refer to each other, so rename the tasks `t1`, `t2`, ... Two parents
 * in three are the task before, which makes chains for trunks to fold; the rest point anywhere,
 * or at a task that does not exist. Parents can form cycles.
 */
const planOf = (generated: typeof Plan.Type, finished = 0): ReadonlyArray<BoxTask> => {
  const pool = Array.append(
    Array.map(generated, (_, index) => id(index + 1)),
    ghost,
  );
  const relink = (seed: string, index: number): TaskId =>
    hash(seed) % 3 === 0
      ? Option.getOrElse(Array.get(pool, hash(seed) % Array.length(pool)), () => ghost)
      : Option.getOrElse(Array.get(pool, Number.max(0, index - 1)), () => ghost);
  return Array.map(generated, (task, index) => ({
    dependsOn: [],
    id: id(index + 1),
    parent: Option.getOrNull(
      Option.map(Option.fromNullOr(task.parent), (parent) => relink(parent, index)),
    ),
    specSections: task.specSections,
    // The first tasks are done, so that trunks are common.
    status: index < finished ? "done" : task.status,
  }));
};

/** Every stack's box, folded or not. */
const boxesOf = (tasks: ReadonlyArray<BoxTask>, isUnfolded: boolean): ReadonlyArray<Box> =>
  Array.map(stacksOf(tasks), (stack) => boxOf(stack, tasks, isUnfolded));

const folded = (box: Box): ReadonlyArray<TaskId> =>
  Option.match(box.maybeTrunk, {
    onNone: () => [],
    onSome: (trunk) => (trunk.isFolded ? trunk.tasks : []),
  });

const stackTasks = (box: Box, tasks: ReadonlyArray<BoxTask>): ReadonlyArray<BoxTask> =>
  Array.filter(tasks, (task) => Record.has(box.stack.cells, task.id));

/** A task's children in its box's stack, the root never being a child. */
const childrenIn = (box: Box, tasks: ReadonlyArray<BoxTask>, of: TaskId): ReadonlyArray<BoxTask> =>
  Array.filter(stackTasks(box, tasks), (task) => task.parent === of && task.id !== box.stack.root);

/** A task and everything built on it in the stack. */
const subtreeOf = (box: Box, tasks: ReadonlyArray<BoxTask>, root: TaskId): ReadonlyArray<TaskId> =>
  Array.prepend(
    Array.flatMap(childrenIn(box, tasks, root), (child) => subtreeOf(box, tasks, child.id)),
    root,
  );

const cellOf = (box: Box, task: TaskId) => Option.getOrThrow(Record.get(box.cells, task));

it.prop(
  "unfolded, every task has a cell in the row stacksOf gave it; folded, exactly the trunk's tasks have none",
  [Plan, Finished],
  ([generated, finished]) => {
    const tasks = planOf(generated, finished);
    Array.forEach(boxesOf(tasks, true), (box) => {
      expect(Array.sort(Record.keys(box.cells), TaskIdOrder)).toEqual(
        Array.sort(Record.keys(box.stack.cells), TaskIdOrder),
      );
      Array.forEach(Record.toEntries(box.stack.cells), ([task, place]) => {
        expect(cellOf(box, TaskId.make(task)).row).toBe(place.row);
        expect(cellOf(box, TaskId.make(task)).column).toBe(place.column);
      });
      expect(box.rows).toBe(
        Array.reduce(Record.values(box.cells), 0, (r, cell) => Number.max(r, cell.row)),
      );
    });
    Array.forEach(boxesOf(tasks, false), (box) => {
      const hidden = folded(box);
      const missing = Array.filter(
        Record.keys(box.stack.cells),
        (task) => !Record.has(box.cells, task),
      );
      expect(Array.sort(missing, TaskIdOrder)).toEqual(Array.sort(hidden, TaskIdOrder));
      Array.forEach(Record.toEntries(box.cells), ([task, cell]) =>
        expect(cell.row).toBe(
          Option.getOrThrow(Record.get(box.stack.cells, TaskId.make(task))).row -
            Array.length(hidden),
        ),
      );
    });
  },
);

it.prop(
  "no two cells in one row share a column, counting every column of each span",
  [Plan, Finished, Schema.Boolean],
  ([generated, finished, isUnfolded]) => {
    Array.forEach(boxesOf(planOf(generated, finished), isUnfolded), (box) => {
      const used = Array.flatMap(Record.values(box.cells), (cell) =>
        Array.makeBy(cell.span, (offset) => `${cell.row}:${cell.column + offset}`),
      );
      expect(Array.dedupe(used)).toEqual(used);
    });
  },
);

it.prop(
  "a task's columns cover each of its children's, and the columns under any task are one unbroken run",
  [Plan, Finished, Schema.Boolean],
  ([generated, finished, isUnfolded]) => {
    const tasks = planOf(generated, finished);
    Array.forEach(boxesOf(tasks, isUnfolded), (box) => {
      Array.forEach(Record.toEntries(box.cells), ([task, cell]) => {
        const children = Array.filter(childrenIn(box, tasks, TaskId.make(task)), (child) =>
          Record.has(box.cells, child.id),
        );
        Array.forEach(children, (child) => {
          const below = cellOf(box, child.id);
          expect(below.column).toBeGreaterThanOrEqual(cell.column);
          expect(below.column + below.span).toBeLessThanOrEqual(cell.column + cell.span);
        });
        // The first columns of the task and of everything built on it fill its columns.
        const columns = Array.dedupe(
          Array.map(
            Array.filter(subtreeOf(box, tasks, TaskId.make(task)), (below) =>
              Record.has(box.cells, below),
            ),
            (below) => cellOf(box, below).column,
          ),
        );
        expect(Array.sort(columns, Order.Number)).toEqual(
          Array.makeBy(cell.span, (offset) => cell.column + offset),
        );
      });
    });
  },
);

it.prop(
  "there is one arrow per parent link whose child has a cell, from the segment for a folded trunk's children",
  [Plan, Finished, Schema.Boolean],
  ([generated, finished, isUnfolded]) => {
    const tasks = planOf(generated, finished);
    Array.forEach(boxesOf(tasks, isUnfolded), (box) => {
      const hidden = folded(box);
      const expected = Array.flatMap(stackTasks(box, tasks), (child) =>
        Array.flatMap(Option.toArray(Option.fromNullOr(child.parent)), (parent) =>
          child.id === box.stack.root || Array.contains(hidden, child.id)
            ? []
            : [
                {
                  kind: "parent" as const,
                  source: Array.contains(hidden, parent)
                    ? `segment:${box.stack.root}`
                    : `task:${parent}`,
                  target: Record.has(box.forkLabels, child.id)
                    ? `fork:${child.id}`
                    : `task:${child.id}`,
                },
              ],
        ),
      );
      const byKey = Order.mapInput(
        Order.String,
        (arrow: Box["arrows"][number]) => `${arrow.source} ${arrow.target}`,
      );
      expect(Array.sort(box.arrows, byKey)).toEqual(Array.sort(expected, byKey));
    });
  },
);

it.prop(
  "every arrow's ends are keys of a cell, a fork label or the segment",
  [Plan, Finished, Schema.Boolean],
  ([generated, finished, isUnfolded]) => {
    Array.forEach(boxesOf(planOf(generated, finished), isUnfolded), (box) => {
      const keys = HashSet.fromIterable(
        Array.flatten([
          Array.map(Record.keys(box.cells), (task) => `task:${task}`),
          Array.map(Record.keys(box.forkLabels), (task) => `fork:${task}`),
          Array.map(folded(box), () => `segment:${box.stack.root}`),
        ]),
      );
      Array.forEach(box.arrows, (arrow) => {
        expect(arrow.kind).toBe("parent");
        expect(HashSet.has(keys, arrow.source)).toBe(true);
        expect(HashSet.has(keys, arrow.target)).toBe(true);
        // An arrow ends at a label when its child has one, and never at a segment.
        expect(String.startsWith("segment:")(arrow.target)).toBe(false);
      });
    });
  },
);

it.prop(
  "a trunk never holds one task, and a box without one is the same folded or not",
  [Plan, Finished],
  ([generated, finished]) => {
    const tasks = planOf(generated, finished);
    Array.forEach(stacksOf(tasks), (stack) => {
      const closed = boxOf(stack, tasks, false);
      const open = boxOf(stack, tasks, true);
      Array.forEach([closed, open], (box) =>
        Option.match(box.maybeTrunk, {
          onNone: () => undefined,
          onSome: (trunk) => {
            expect(Array.length(trunk.tasks)).toBeGreaterThanOrEqual(2);
            expect(trunk.root).toBe(stack.root);
          },
        }),
      );
      expect(Option.isSome(closed.maybeTrunk)).toBe(Option.isSome(open.maybeTrunk));
      if (Option.isNone(closed.maybeTrunk)) {
        expect(closed).toEqual(open);
      }
    });
  },
);

it.prop(
  "a fork's children are labelled with the last part of their first spec section",
  [Plan, Finished],
  ([generated, finished]) => {
    const tasks = planOf(generated, finished);
    Array.forEach(boxesOf(tasks, true), (box) => {
      const forkChildren = pipe(
        stackTasks(box, tasks),
        Array.filter((task) => Array.length(childrenIn(box, tasks, task.id)) >= 2),
        Array.flatMap((task) => childrenIn(box, tasks, task.id)),
      );
      expect(Array.sort(Record.keys(box.forkLabels), TaskIdOrder)).toEqual(
        Array.sort(
          Array.map(forkChildren, (child) => child.id),
          TaskIdOrder,
        ),
      );
      Array.forEach(forkChildren, (child) =>
        expect(Record.get(box.forkLabels, child.id)).toEqual(
          Option.flatMap(Array.head(child.specSections), (section) =>
            Array.last(String.split(section, ".")),
          ),
        ),
      );
    });
  },
);

const stackOf = (number: number): Stack =>
  Option.getOrThrow(Array.findFirst(stacksOf(demoTrace.tasks), (stack) => stack.number === number));

const spans = (box: Box): Record.ReadonlyRecord<string, number> =>
  Record.map(box.cells, (cell) => cell.span);

it("Stack 24 folds t45 to t52 into a segment, and row 1 holds its three branches", () => {
  const stack = stackOf(24);
  const box = boxOf(stack, demoTrace.tasks, false);
  const trunk = Option.getOrThrow(box.maybeTrunk);
  expect(trunk).toEqual({
    isFolded: true,
    root: id(45),
    tasks: Array.makeBy(8, (index) => id(45 + index)),
  });
  expect(trunkLabelOf(stack, trunk)).toBe("t45–t52 · viewer · 8 done");
  expect(trunkLabelOf({ area: Option.none() }, trunk)).toBe("t45–t52 · 8 done");
  expect(Record.has(box.cells, id(45))).toBe(false);
  const rowOne = Array.sort(
    Record.keys(Record.filter(box.cells, (cell) => cell.row === 1)),
    TaskIdOrder,
  );
  expect(rowOne).toEqual([id(69), id(71), id(75)]);
  expect(Array.map(rowOne, (task) => Record.get(box.forkLabels, task))).toEqual([
    Option.some("stacks"),
    Option.some("fuzzy-matching"),
    Option.some("code-view"),
  ]);
  expect(Record.get(spans(box), id(54))).toEqual(Option.some(2));
  expect(Record.get(box.forkLabels, id(67))).toEqual(Option.some("server"));
  expect(Record.get(box.forkLabels, id(81))).toEqual(Option.some("demo-data"));
  const endKey = endKeyOf(box);
  expect(endKey(id(48))).toBe("segment:t45");
  expect(endKey(id(54))).toBe("task:t54");
  expect(box.arrows).toContainEqual({ kind: "parent", source: "segment:t45", target: "fork:t69" });
  expect(Array.some(box.arrows, (arrow) => arrow.source === "task:t46")).toBe(false);
});

it("unfolded, Stack 24 keeps every task in the row stacksOf gave it", () => {
  const box = boxOf(stackOf(24), demoTrace.tasks, true);
  expect(box.rows).toBe(12);
  expect(Record.size(box.cells)).toBe(Record.size(box.stack.cells));
  expect(endKeyOf(box)(id(48))).toBe("task:t48");
  expect(box.arrows).toContainEqual({ kind: "parent", source: "task:t52", target: "fork:t69" });
});

it("Stack 13, unfolded, has t20 with the children t25 and t111", () => {
  const box = boxOf(stackOf(13), demoTrace.tasks, true);
  expect(
    Array.sort(
      Array.map(
        Array.filter(demoTrace.tasks, (task) => task.parent === id(20)),
        (task) => task.id,
      ),
      TaskIdOrder,
    ),
  ).toEqual([id(25), id(111)]);
  expect(Record.get(box.forkLabels, id(25))).toEqual(Option.some("lint"));
  expect(Record.get(box.forkLabels, id(111))).toEqual(Option.some("stack-order"));
  expect(Record.get(spans(box), id(20))).toEqual(Option.some(2));
});

it("a trunk of one task stays a chip", () => {
  const tasks: ReadonlyArray<BoxTask> = [
    {
      dependsOn: [],
      id: id(1),
      parent: null,
      specSections: Schema.decodeSync(BoxTask.fields.specSections)(["spec.viewer.stacks"]),
      status: "done",
    },
    {
      dependsOn: [],
      id: id(2),
      parent: id(1),
      specSections: Schema.decodeSync(BoxTask.fields.specSections)(["spec.viewer.stacks"]),
      status: "pending",
    },
  ];
  const [stack] = stacksOf(tasks);
  const box = boxOf(Option.getOrThrow(Option.fromUndefinedOr(stack)), tasks, false);
  expect(box.maybeTrunk).toEqual(Option.none());
  expect(Record.keys(box.cells)).toEqual([id(1), id(2)]);
  expect(box.rows).toBe(2);
});

/** The roots a plan unfolds: about half. */
const unfoldedOf = (tasks: ReadonlyArray<BoxTask>): Record<string, boolean> =>
  Record.fromIterableWith(stacksOf(tasks), (stack) => [stack.root, hash(stack.root) % 2 === 0]);

it.prop(
  "stackBoxesOf gives each stack its box, unfolded exactly when its root is named",
  [Plan, Finished],
  ([generated, finished]) => {
    const tasks = planOf(generated, finished);
    const unfolded = unfoldedOf(tasks);
    const boxes = stackBoxesOf(tasks, unfolded);
    expect(Array.map(boxes, (box) => box.stack)).toEqual(stacksOf(tasks));
    Array.forEach(boxes, (box) => {
      const isUnfolded = Record.get(unfolded, box.stack.root).pipe(Option.getOrElse(() => false));
      expect(box).toEqual(boxOf(box.stack, tasks, isUnfolded));
      expect(Option.map(box.maybeTrunk, (trunk) => trunk.isFolded)).toEqual(
        Option.map(box.maybeTrunk, () => !isUnfolded),
      );
    });
    // No root named: every trunk is folded.
    Array.forEach(stackBoxesOf(tasks, {}), (box) =>
      expect(
        Option.getOrElse(
          Option.map(box.maybeTrunk, (trunk) => trunk.isFolded),
          () => true,
        ),
      ).toBe(true),
    );
  },
);

it.prop(
  "over every box, a drawn task's key is its chip's and a folded task's is its trunk's segment",
  [Plan, Finished],
  ([generated, finished]) => {
    const tasks = planOf(generated, finished);
    const boxes = stackBoxesOf(tasks, unfoldedOf(tasks));
    const endKey = endKeyInOf(boxes);
    Array.forEach(boxes, (box) =>
      Array.forEach(Record.keys(box.stack.cells), (task) => {
        expect(endKey(task)).toBe(endKeyOf(box)(task));
        expect(endKey(task)).toBe(
          Record.has(box.cells, task) ? `task:${task}` : `segment:${box.stack.root}`,
        );
      }),
    );
    // A task no stack holds is its own chip.
    expect(endKey(ghost)).toBe("task:ghost");
  },
);
