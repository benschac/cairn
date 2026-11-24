import type { Trace, TraceTask } from "@cairn/contract";
import { labelOf, stacksOf, type Stack, type StackPosition } from "@cairn/core/stacks";
import { Array, Number, Option, Order, Record, String, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Movable, offsetStyleOf, type Offsets } from "../drag.ts";
import { nodeSearchOf, type LitChain, type Pin } from "../highlight.ts";
import type { Message } from "../message.ts";
import type { SearchResult } from "../search.ts";
import type { Node } from "../trace.ts";
import { moveHandleView } from "./moveHandleView.ts";
import {
  fieldFromView,
  fieldView,
  judgmentMarkViews,
  nodeAttributes,
  nodeButtonView,
  titleView,
} from "./nodeView.ts";

/** Where a task without a cell would sit. stacksOf places every task it is given. */
const UNPLACED_TASK_POSITION: StackPosition = { column: 1, row: 1 };

/** The task card's grip sits in its top right corner, on the model band. */
const TASK_HANDLE_STYLE = { position: "absolute", right: "4px", top: "2px" };

/** Pixels between two rows of stacks, and between two stacks in a row. */
const STACK_GAP = "32px";

interface ModelColor {
  readonly background: string;
  readonly color: string;
}

/** The diagram's model colours: fill, then text. */
const MODEL_COLOR: Record.ReadonlyRecord<string, ModelColor> = {
  haiku: { background: "#facc15", color: "#111111" },
  opus: { background: "#7c3aed", color: "#ffffff" },
  sonnet: { background: "#2563eb", color: "#ffffff" },
};

/** A model the diagram has no colour for. */
const OTHER_MODEL_COLOR: ModelColor = { background: "#6b7280", color: "#ffffff" };

const modelColorOf = (model: string) =>
  Option.getOrElse(Record.get(MODEL_COLOR, model), () => OTHER_MODEL_COLOR);

/** A human gate's border, as the diagram draws it; any other card's. */
const GATE_BORDER = "3px solid #dc2626";
const CARD_BORDER = "1px solid #94a3b8";

/** Where a branch's name starts once its `<feature>/` prefix is left off. */
export const branchStartOf = (feature: string, branch: string): number =>
  String.startsWith(`${feature}/`)(branch) ? String.length(feature) + 1 : 0;

/** What a card's first line says: the ID, the branch without its feature prefix, and GATE. */
export const taskHeadingOf = (trace: Trace, task: TraceTask): string =>
  Array.join(
    Array.flatten([
      [task.id, String.slice(branchStartOf(trace.feature, task.branch))(task.branch)],
      task.gate.required ? ["GATE"] : [],
    ]),
    " · ",
  );

/** A text that starts a new line inside the card's button, which holds only phrasing content. */
const lineView = (children: ReadonlyArray<Html | string>, h: HtmlBuilder<Message>): Html =>
  h.span([h.Style({ display: "block" })], children);

/**
 * A task's card at its cell in its stack's grid, moved by its offset. It reads like a diagram
 * node: a band in the model's colour, the ID, branch and GATE, the title, the worktree, then the
 * status. Row 1 is the bottom row, so `topRow` is the stack's top row.
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
    border: task.gate.required ? GATE_BORDER : CARD_BORDER,
    "border-radius": "6px",
    "grid-column": `${position.column}`,
    // Row 1 is the bottom, so a task's parent sits in the grid row below it.
    "grid-row": `${topRow - position.row + 1}`,
    overflow: "hidden",
    padding: "0 8px 6px",
    position: "relative",
  };
  const model = modelColorOf(task.model);
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
        h.div(
          [
            h.DataAttribute("model", task.model),
            h.Style({
              background: model.background,
              color: model.color,
              "font-size": "11px",
              margin: "0 -8px 6px",
              padding: "2px 28px 2px 8px",
            }),
          ],
          [task.model],
        ),
        h.span([h.Style(TASK_HANDLE_STYLE)], [moveHandleView(movable, `Move ${task.id}`, h)]),
        nodeButtonView(
          node,
          pins,
          [
            lineView(
              Array.flatten([
                [h.strong([], fieldView(search, "id", task.id, h)), " · "],
                [
                  h.span(
                    [h.DataAttribute("field", "branch")],
                    fieldFromView(
                      search,
                      "branch",
                      task.branch,
                      branchStartOf(trace.feature, task.branch),
                      h,
                    ),
                  ),
                ],
                task.gate.required
                  ? [
                      " · ",
                      h.span(
                        [
                          h.DataAttribute("gate", ""),
                          h.Style({ color: "#dc2626", "font-weight": "700" }),
                        ],
                        ["GATE"],
                      ),
                    ]
                  : [],
              ]),
              h,
            ),
            // The space keeps the heading and the title apart in the button's accessible name.
            " ",
            lineView(titleView(search, [task.title], h), h),
          ],
          h,
        ),
        h.div(
          [h.DataAttribute("field", "worktree"), h.Style({ "font-size": "12px", opacity: "0.8" })],
          [Option.getOrElse(Option.fromNullOr(task.worktree), () => "main checkout")],
        ),
        h.div([h.DataAttribute("status", task.status)], [task.status]),
      ],
      judgmentMarkViews(trace, { id: task.id, kind: "task" }, h),
    ]),
  );
};

/**
 * One stack: a grey box like the diagram's subgraphs, its label at the top, and a grid of its
 * cards that is only as tall as its deepest chain.
 */
const stackView = (
  trace: Trace,
  stack: Stack,
  lit: ReadonlyArray<LitChain>,
  pins: ReadonlyArray<Pin>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  offsets: Offsets,
  h: HtmlBuilder<Message>,
): Html => {
  const topRow = Array.reduce(Record.values(stack.cells), 1, (highest, cell) =>
    Number.max(highest, cell.row),
  );
  const label = labelOf(stack);
  return h.keyed("div")(
    `stack-${stack.number}`,
    [
      h.Role("group"),
      h.AriaLabel(label),
      h.DataAttribute("stack", `${stack.number}`),
      h.Style({
        background: "#f3f4f6",
        border: "1px solid #d1d5db",
        "border-radius": "8px",
        padding: "6px 8px 8px",
      }),
    ],
    [
      h.div(
        [
          h.DataAttribute("stack-label", ""),
          h.Style({ color: "#374151", "font-size": "11px", "margin-bottom": "6px" }),
        ],
        [label],
      ),
      h.div(
        [h.Style({ display: "grid", gap: "8px", "grid-auto-columns": "200px" })],
        Array.map(
          Array.filter(trace.tasks, (task) => Record.has(stack.cells, task.id)),
          (task) =>
            taskCardView(
              trace,
              task,
              Option.getOrElse(Record.get(stack.cells, task.id), () => UNPLACED_TASK_POSITION),
              topRow,
              lit,
              pins,
              results,
              maybeActive,
              offsets,
              h,
            ),
        ),
      ),
    ],
  );
};

/**
 * The bar the bottom row of stacks starts from, labelled with the base branch. It is not a node:
 * nothing measures, hovers or pins it, and no curve runs to it.
 */
const baseBranchView = (trace: Trace, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.DataAttribute("base-branch", trace.baseBranch),
      h.Style({
        background: "#e5e7eb",
        border: "1px solid #6b7280",
        "border-radius": "999px",
        color: "#111111",
        padding: "4px 12px",
        "text-align": "center",
      }),
    ],
    [trace.baseBranch],
  );

/**
 * The plan's stack diagram: rows of stacks over the base branch, the highest level at the top.
 * Each row holds its stacks in number order, aligned to the bottom.
 */
export const stacksView = (
  trace: Trace,
  lit: ReadonlyArray<LitChain>,
  pins: ReadonlyArray<Pin>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  offsets: Offsets,
  h: HtmlBuilder<Message>,
): Html => {
  const levels = pipe(
    Array.groupBy(stacksOf(trace.tasks), (stack) => `${stack.level}`),
    Record.values,
    Array.sortWith((row) => Array.headNonEmpty(row).level, Order.flip(Order.Number)),
  );
  return h.div(
    [
      h.DataAttribute("stacks", ""),
      h.Style({
        display: "flex",
        "flex-direction": "column",
        gap: STACK_GAP,
        width: "max-content",
      }),
    ],
    Array.append(
      Array.map(levels, (row) =>
        h.keyed("div")(
          `level-${Array.headNonEmpty(row).level}`,
          [
            h.DataAttribute("level", `${Array.headNonEmpty(row).level}`),
            h.Style({ "align-items": "flex-end", display: "flex", gap: STACK_GAP }),
          ],
          Array.map(row, (stack) =>
            stackView(trace, stack, lit, pins, results, maybeActive, offsets, h),
          ),
        ),
      ),
      baseBranchView(trace, h),
    ),
  );
};
