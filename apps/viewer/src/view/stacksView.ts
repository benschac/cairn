import type { Trace, TraceTask } from "@cairn/contract";
import { Array, Number, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "../message.ts";
import { stackLayoutOf, type StackPosition } from "../stacks.ts";
import { judgmentMarkOf, type Chain } from "../trace.ts";
import { judgmentView, nodeAttributes } from "./nodeView.ts";

/** Where a task without a position would sit. stackLayoutOf places every task it is given. */
const origin: StackPosition = { column: 1, row: 1 };

/** A task's card at its place in the grid. Row 1 is the bottom row, so `top` is the top row. */
const taskCardView = (
  trace: Trace,
  task: TraceTask,
  position: StackPosition,
  top: number,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("div")(
    task.id,
    Array.appendAll(
      [
        h.DataAttribute("task", task.id),
        h.Style({
          border: "1px solid #94a3b8",
          "border-radius": "6px",
          "grid-column": String(position.column),
          // Row 1 is the bottom, so everything a task needs sits below it.
          "grid-row": String(top - position.row + 1),
          padding: "6px 8px",
        }),
      ],
      nodeAttributes(maybeChain, { id: task.id, kind: "task" }, h),
    ),
    Array.flatten([
      [
        h.strong([], [task.id]),
        ` ${task.title}`,
        h.div([h.DataAttribute("field", "branch")], [task.branch]),
        h.div([h.DataAttribute("field", "model")], [task.model]),
        h.div([h.DataAttribute("status", task.status)], [task.status]),
      ],
      task.gate.required ? [h.span([h.DataAttribute("gate", "")], ["human gate"])] : [],
      Array.fromOption(
        Option.map(judgmentMarkOf(trace, { id: task.id, kind: "task" }), (mark) =>
          judgmentView(mark, h),
        ),
      ),
    ]),
  );

export const stacksView = (
  trace: Trace,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html => {
  const layout = stackLayoutOf(trace.tasks);
  const top = Array.reduce(Record.values(layout), 1, (highest, position) =>
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
        Option.getOrElse(Record.get(layout, task.id), () => origin),
        top,
        maybeChain,
        h,
      ),
    ),
  );
};
