import type { Trace, TraceTask } from "@cairn/contract";
import { Array, Number, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Movable, offsetStyleOf, type Offsets } from "../drag.ts";
import { nodeSearchOf, type LitChain, type Pin } from "../highlight.ts";
import type { Message } from "../message.ts";
import type { SearchResult } from "../search.ts";
import { stackLayoutOf, type StackPosition } from "../stacks.ts";
import type { Node } from "../trace.ts";
import { moveHandleView } from "./moveHandleView.ts";
import {
  fieldView,
  judgmentMarkViews,
  nodeAttributes,
  nodeButtonView,
  titleView,
} from "./nodeView.ts";

/** Where a task without a position would sit. stackLayoutOf places every task it is given. */
const UNPLACED_TASK_POSITION: StackPosition = { column: 1, row: 1 };

/** The task card's grip sits in its top right corner, clear of the title. */
const TASK_HANDLE_STYLE = { position: "absolute", right: "4px", top: "4px" };

/**
 * A task's card at its place in the grid, moved by its offset. Row 1 is the bottom row, so
 * `topRow` is the top row.
 */
const taskCardView = (
  trace: Trace,
  task: TraceTask,
  position: StackPosition,
  topRow: number,
  lit: ReadonlyArray<LitChain>,
  pins: ReadonlyArray<Pin>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  offsets: Offsets,
  h: HtmlBuilder<Message>,
): Html => {
  const movable = Movable.Task({ id: task.id });
  const node: Node = { id: task.id, kind: "task" };
  const search = nodeSearchOf(results, maybeActive, node);
  const cellStyle = {
    border: "1px solid #94a3b8",
    "border-radius": "6px",
    "grid-column": String(position.column),
    // Row 1 is the bottom, so everything a task needs sits below it.
    "grid-row": String(topRow - position.row + 1),
    padding: "6px 28px 6px 8px",
    position: "relative",
  };
  return h.keyed("div")(
    task.id,
    Array.prepend(
      nodeAttributes(
        lit,
        node,
        search,
        h,
        Record.union(cellStyle, offsetStyleOf(offsets, movable), (_own, offset) => offset),
      ),
      h.DataAttribute("task", task.id),
    ),
    Array.flatten([
      [
        h.span([h.Style(TASK_HANDLE_STYLE)], [moveHandleView(movable, `Move ${task.id}`, h)]),
        nodeButtonView(
          node,
          pins,
          Array.appendAll(
            [h.strong([], fieldView(search, "id", task.id, h)), " "],
            titleView(search, [task.title], h),
          ),
          h,
        ),
        h.div([h.DataAttribute("field", "branch")], fieldView(search, "branch", task.branch, h)),
        h.div([h.DataAttribute("field", "model")], [task.model]),
        h.div([h.DataAttribute("status", task.status)], [task.status]),
      ],
      task.gate.required ? [h.span([h.DataAttribute("gate", "")], ["human gate"])] : [],
      judgmentMarkViews(trace, { id: task.id, kind: "task" }, h),
    ]),
  );
};

export const stacksView = (
  trace: Trace,
  lit: ReadonlyArray<LitChain>,
  pins: ReadonlyArray<Pin>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  offsets: Offsets,
  h: HtmlBuilder<Message>,
): Html => {
  const layout = stackLayoutOf(trace.tasks);
  const topRow = Array.reduce(Record.values(layout), 1, (highest, position) =>
    Number.max(highest, position.row),
  );
  return h.div(
    [
      h.DataAttribute("stacks", ""),
      h.Style({
        display: "grid",
        gap: "8px",
        "grid-auto-columns": "200px",
        width: "max-content",
      }),
    ],
    Array.map(trace.tasks, (task) =>
      taskCardView(
        trace,
        task,
        Option.getOrElse(Record.get(layout, task.id), () => UNPLACED_TASK_POSITION),
        topRow,
        lit,
        pins,
        results,
        maybeActive,
        offsets,
        h,
      ),
    ),
  );
};
