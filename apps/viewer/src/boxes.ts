import { TaskId, TaskStatus } from "@cairn/contract";
import type { RelationIndex } from "@cairn/core/relation-index";
import { Stack, StackTask, TaskIdOrder, stacksOf } from "@cairn/core/stacks";
import { Array, Number, Option, Record, Schema, String, Struct, pipe } from "effect";

import { trunkOf } from "./links.ts";

/** What a box reads of a task: the stack's view of it and its status. A `TraceTask` fits. */
export const BoxTask = StackTask.mapFields(Struct.assign({ status: TaskStatus }));
export type BoxTask = typeof BoxTask.Type;

const Place = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** A finished trunk of two or more tasks, from the stack's root up to the first fork. */
export const Trunk = Schema.Struct({
  isFolded: Schema.Boolean,
  root: TaskId,
  tasks: Schema.NonEmptyArray(TaskId),
});
export type Trunk = typeof Trunk.Type;

/** Where a chip is drawn: its first column, the columns it is centred across and its row. */
export const BoxCell = Schema.Struct({ column: Place, row: Place, span: Place });
export type BoxCell = typeof BoxCell.Type;

/** An arrow between two `data-wire` keys. */
export const ArrowLink = Schema.Struct({
  kind: Schema.Literals(["parent", "dependency"]),
  source: Schema.String,
  target: Schema.String,
});
export type ArrowLink = typeof ArrowLink.Type;

/** What a stack's box draws, worked out before it is drawn. */
export const Box = Schema.Struct({
  arrows: Schema.Array(ArrowLink),
  cells: Schema.Record(TaskId, BoxCell),
  forkLabels: Schema.Record(TaskId, Schema.String),
  maybeTrunk: Schema.Option(Trunk),
  rows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stack: Stack,
});
export type Box = typeof Box.Type;

/**
 * The key an arrow leaves a task from: `segment:<root>` for a task inside a folded trunk, whose
 * chips are one segment, and `task:<id>` for any other.
 */
export const endKeyOf =
  (box: Pick<Box, "maybeTrunk">) =>
  (id: TaskId): string =>
    Option.match(
      Option.filter(box.maybeTrunk, (trunk) => trunk.isFolded && Array.contains(trunk.tasks, id)),
      { onNone: () => `task:${id}`, onSome: (trunk) => `segment:${trunk.root}` },
    );

/**
 * What `endKeyOf` gives over every box at once: the one folded trunk that holds the task decides,
 * and any other task is its own chip.
 */
export const endKeyInOf =
  (boxes: ReadonlyArray<Pick<Box, "maybeTrunk">>) =>
  (id: TaskId): string =>
    Option.match(
      Array.findFirst(
        Array.flatMap(boxes, (box) => Option.toArray(box.maybeTrunk)),
        (trunk) => trunk.isFolded && Array.contains(trunk.tasks, id),
      ),
      { onNone: () => `task:${id}`, onSome: (trunk) => `segment:${trunk.root}` },
    );

/** `t45–t52 · viewer · 8 done`, or `t45–t52 · 8 done` for a stack with no area. */
export const trunkLabelOf = (stack: Pick<Stack, "area">, trunk: Trunk): string =>
  Array.join(
    Array.flatten([
      [`${Array.headNonEmpty(trunk.tasks)}–${Array.lastNonEmpty(trunk.tasks)}`],
      Option.toArray(stack.area),
      [`${Array.length(trunk.tasks)} done`],
    ]),
    " · ",
  );

/** The last `.`-separated part of a task's first spec section: `fuzzy-matching` for `spec.viewer.fuzzy-matching`. */
const forkLabelOf = (task: BoxTask): Option.Option<string> =>
  Option.flatMap(Array.head(task.specSections), (section) =>
    Array.last(String.split(section, ".")),
  );

/**
 * The box of every stack, each folded unless `unfolded` holds its root as `true`. `index` says what
 * each task needs; the view passes the trace's, built once.
 */
export const stackBoxesOf = (
  tasks: ReadonlyArray<BoxTask>,
  unfolded: Record.ReadonlyRecord<string, boolean>,
  index?: Pick<RelationIndex, "out">,
): ReadonlyArray<Box> =>
  Array.map(stacksOf(tasks, index), (stack) =>
    boxOf(
      stack,
      tasks,
      Option.getOrElse(Record.get(unfolded, stack.root), () => false),
    ),
  );

/**
 * What the box of a stack draws. Columns and rows come from `stacksOf`; the box adds each cell's
 * span, folds a finished trunk of two or more tasks unless `isUnfolded`, labels the children of
 * forks and lists the parent arrows that are drawn.
 */
export const boxOf = (stack: Stack, tasks: ReadonlyArray<BoxTask>, isUnfolded: boolean): Box => {
  const members = Array.sortWith(
    Array.filter(tasks, (task) => Record.has(stack.cells, task.id)),
    (task: BoxTask) => task.id,
    TaskIdOrder,
  );
  // The root's own parent may close a cycle, so it is never a child.
  const childrenOf = (task: BoxTask): ReadonlyArray<BoxTask> =>
    Array.filter(members, (child) => child.parent === task.id && child.id !== stack.root);
  const columnOf = (task: BoxTask): number =>
    Option.match(Record.get(stack.cells, task.id), {
      onNone: () => 1,
      onSome: (cell) => cell.column,
    });
  const lastColumnOf = (task: BoxTask): number =>
    Array.reduce(childrenOf(task), columnOf(task), (last, child) =>
      Number.max(last, lastColumnOf(child)),
    );

  const trunkIds = Array.map(trunkOf(stack, members), (task) => task.id);
  // A trunk of one task stays a chip.
  const maybeTrunk = Array.match(trunkIds, {
    onEmpty: () => Option.none<Trunk>(),
    onNonEmpty: (ids) =>
      Array.length(ids) >= 2
        ? Option.some<Trunk>({ isFolded: !isUnfolded, root: stack.root, tasks: ids })
        : Option.none<Trunk>(),
  });
  const hidden = Option.match(maybeTrunk, {
    onNone: () => [],
    onSome: (trunk) => (trunk.isFolded ? trunk.tasks : []),
  });
  const dropped = Array.length(hidden);
  const isDrawn = (task: BoxTask): boolean => !Array.contains(hidden, task.id);

  const drawn = Array.filter(members, isDrawn);
  const cells = Record.fromIterableWith(drawn, (task) => {
    const column = columnOf(task);
    return [
      task.id,
      {
        column,
        row: Option.match(Record.get(stack.cells, task.id), {
          onNone: () => 1,
          onSome: (cell) => cell.row - dropped,
        }),
        span: lastColumnOf(task) - column + 1,
      },
    ];
  });

  const forkLabels = pipe(
    members,
    Array.filter((task) => Array.length(childrenOf(task)) >= 2),
    Array.flatMap(childrenOf),
    Array.flatMap((child) =>
      Array.map(Option.toArray(forkLabelOf(child)), (label) => [child.id, label] as const),
    ),
    Record.fromEntries,
  );

  const endKey = endKeyOf({ maybeTrunk });

  return {
    arrows: Array.flatMap(drawn, (child) =>
      pipe(
        Option.fromNullOr(child.parent),
        Option.filter(() => child.id !== stack.root),
        Option.filter((parent) => Record.has(stack.cells, parent)),
        Option.map((parent): ArrowLink => ({
          kind: "parent",
          source: endKey(parent),
          target: Record.has(forkLabels, child.id) ? `fork:${child.id}` : `task:${child.id}`,
        })),
        Option.toArray,
      ),
    ),
    cells,
    forkLabels,
    maybeTrunk,
    rows: Array.reduce(Record.values(cells), 0, (highest, cell) => Number.max(highest, cell.row)),
    stack,
  };
};
