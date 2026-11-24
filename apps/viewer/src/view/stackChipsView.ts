import type { PrdSectionId, SectionStatus, Trace, TraceTask } from "@cairn/contract";
import { Array, Effect, HashSet, Number, Option, Order, Record, String, pipe } from "effect";
import { Mount } from "foldkit";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../message.ts";
import { currentTasksOf, planCountsOf, ranOf } from "../reader.ts";
import { labelOf, stacksOf, type Stack } from "../stacks.ts";
import type { Chain, Node } from "../trace.ts";
import { dotView, labelView } from "../ui/marks.ts";
import { hoverChainOf, isTaskDimmed, taskKey } from "../wires.ts";
import { modelAttributesOf, modelMarkView } from "./modelView.ts";
import { branchStartOf } from "./stacksView.ts";
import { hoverAttributesOf } from "./wiresView.ts";

const isDone = (task: TraceTask): boolean => task.status === "done" || task.status === "landed";

/**
 * Scrolls the pane to the bottom, where the base branch bar is. A Mount runs once, when the pane is
 * inserted, so the pane keeps whatever scroll a person gives it afterwards.
 */
export const ScrollStacksToBottom = Mount.define("ScrollStacksToBottom", {
  execute: ({ element }) =>
    Effect.sync(() => {
      element.scrollTop = element.scrollHeight;
      return Message.CompletedScrollStacks();
    }),
  messages: [Message.CompletedScrollStacks],
});

/** The text a chip gives on hover and to a screen reader. */
export const chipTitleOf = (trace: Trace, task: TraceTask): string =>
  Array.join(
    [
      task.id,
      task.title,
      String.slice(branchStartOf(trace.feature, task.branch))(task.branch),
      Option.getOrElse(Option.fromNullOr(task.worktree), () => "main checkout"),
      task.status,
    ],
    " · ",
  );

const holdsCurrent = (stack: Stack, current: HashSet.HashSet<string>): boolean =>
  Array.some(Record.keys(stack.cells), (id) => HashSet.has(current, id));

/** A task's chip: a status dot and its ID. Row 1 is the bottom, so `topRow` is the box's top row. */
const chipView = (
  trace: Trace,
  task: TraceTask,
  stack: Stack,
  topRow: number,
  current: HashSet.HashSet<string>,
  hasCurrent: boolean,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html => {
  const ran = ranOf(task);
  const position = Option.getOrElse(Record.get(stack.cells, task.id), () => ({
    column: 1,
    row: 1,
  }));
  const isCurrent = HashSet.has(current, task.id);
  const title = chipTitleOf(trace, task);
  return h.keyed("button")(
    task.id,
    Array.flatten([
      [
        h.Type("button"),
        h.Class("chip"),
        h.DataAttribute("task", task.id),
        h.DataAttribute("wire", taskKey(task.id)),
        h.Title(title),
        h.AriaLabel(title),
        h.OnClick(Message.ClickedTask({ id: task.id })),
        h.Style({
          "grid-column": `${position.column}`,
          // A parent sits in the grid row below its child.
          "grid-row": `${topRow - position.row + 1}`,
        }),
      ],
      hoverAttributesOf({ id: task.id, kind: "task" }, h),
      isShowingModels ? modelAttributesOf(ran, h) : [],
      isDone(task) ? [h.DataAttribute("done", "")] : [],
      task.gate.required ? [h.DataAttribute("gated", "")] : [],
      isCurrent ? [h.DataAttribute("current", "")] : [],
      hasCurrent && !isCurrent ? [h.DataAttribute("faded", "")] : [],
      isTaskDimmed(maybeChain, task.id) ? [h.DataAttribute("dimmed", "")] : [],
    ]),
    Array.appendAll(
      [dotView(task.status, h), task.id],
      isShowingModels ? [modelMarkView(ran, h)] : [],
    ),
  );
};

const stackView = (
  trace: Trace,
  stack: Stack,
  current: HashSet.HashSet<string>,
  hasCurrent: boolean,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html => {
  const topRow = Array.reduce(Record.values(stack.cells), 1, (highest, cell) =>
    Number.max(highest, cell.row),
  );
  const label = labelOf(stack);
  return h.keyed("div")(
    `stack-${stack.number}`,
    Array.appendAll(
      [
        h.Class("stack"),
        h.Role("group"),
        h.Title(label),
        h.AriaLabel(label),
        h.DataAttribute("stack", `${stack.number}`),
      ],
      holdsCurrent(stack, current) ? [h.DataAttribute("current", "")] : [],
    ),
    [
      h.div(
        [h.Style({ display: "grid", gap: "4px", "justify-items": "start" })],
        Array.map(
          Array.filter(trace.tasks, (task) => Record.has(stack.cells, task.id)),
          (task) =>
            chipView(
              trace,
              task,
              stack,
              topRow,
              current,
              hasCurrent,
              isShowingModels,
              maybeChain,
              h,
            ),
        ),
      ),
      h.div([h.Class("label"), h.DataAttribute("stack-label", "")], [`${stack.number}`]),
    ],
  );
};

/** "N of M stacks hold this section · X of Y tasks done". */
export const summaryOf = (trace: Trace, current: HashSet.HashSet<string>): string => {
  const stacks = stacksOf(trace.tasks);
  const counts = planCountsOf(trace);
  const holding = Array.length(Array.filter(stacks, (stack) => holdsCurrent(stack, current)));
  return `${holding} of ${Array.length(stacks)} stacks hold this section · ${counts.done} of ${counts.tasks} tasks done`;
};

const swatchView = (
  text: string,
  status: SectionStatus,
  attributes: ReadonlyArray<Attribute<Message>>,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Style({ "align-items": "center", display: "inline-flex", gap: "4px" })],
    [h.span(Array.prepend(attributes, h.Class("chip")), [dotView(status, h)]), text],
  );

/** The legend's colours: the three models Cairn colours, and any other. */
const MODEL_ENTRIES: ReadonlyArray<string> = ["opus", "sonnet", "haiku", "other"];

const modelLegendView = (model: string, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Style({ "align-items": "center", display: "inline-flex", gap: "4px" })],
    [
      h.span([
        h.Class("chip"),
        h.DataAttribute("legend-model", model),
        // "other" is a name no model has a rule for, so it takes the grey.
        h.DataAttribute("model", model),
        h.DataAttribute("ran", "true"),
      ]),
      model,
    ],
  );

/** Over the diagram, held to the top of the pane: the count and the legend. */
const overviewView = (
  trace: Trace,
  current: HashSet.HashSet<string>,
  isShowingModels: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.DataAttribute("stacks-summary", ""),
      h.Style({
        background: "var(--bg)",
        display: "grid",
        gap: "4px",
        padding: "8px 12px",
        position: "sticky",
        top: "0",
        "z-index": "1",
      }),
    ],
    [
      h.p([h.Style({ margin: "0" })], [summaryOf(trace, current)]),
      h.div(
        [
          h.DataAttribute("legend", ""),
          h.Style({ display: "flex", "flex-wrap": "wrap", gap: "4px 12px" }),
        ],
        Array.flatten([
          [labelView("Legend", h)],
          isShowingModels
            ? Array.map(MODEL_ENTRIES, (model) => modelLegendView(model, h))
            : [swatchView("done", "done", [h.DataAttribute("done", "")], h)],
          [
            swatchView("pending", "pending", [], h),
            swatchView("in this section", "pending", [h.DataAttribute("current", "")], h),
            swatchView("a human gate", "blocked_on_human", [h.DataAttribute("gated", "")], h),
            h.span([], ["read up from main"]),
          ],
        ]),
      ),
    ],
  );

/**
 * The stacks pane: every stack, whatever the current section is. The levels are stacked bottom to
 * top, the highest at the top, each a row of its stacks in number order and aligned to the bottom,
 * over a bar labelled with the base branch that stays at the bottom of the pane. The bar is not a
 * node: nothing hovers it and no curve runs to it.
 */
export const stackChipsView = (
  trace: Trace,
  maybeCurrent: Option.Option<PrdSectionId>,
  isShowingModels: boolean,
  maybeHovered: Option.Option<Node>,
  h: HtmlBuilder<Message>,
): Html => {
  const current = currentTasksOf(trace, maybeCurrent);
  const maybeChain = hoverChainOf(trace, maybeHovered);
  const hasCurrent = Option.isSome(maybeCurrent);
  const levels = pipe(
    Array.groupBy(stacksOf(trace.tasks), (stack) => `${stack.level}`),
    Record.values,
    Array.sortWith((row) => Array.headNonEmpty(row).level, Order.flip(Order.Number)),
  );
  return h.div(
    [
      h.Role("region"),
      h.AriaLabel("Stacks"),
      h.DataAttribute("stacks-pane", ""),
      h.OnMount(ScrollStacksToBottom()),
      h.Style({
        display: "flex",
        "flex-direction": "column",
        "min-height": "0",
        "overflow-y": "auto",
      }),
    ],
    [
      overviewView(trace, current, isShowingModels, h),
      h.div(
        [
          h.DataAttribute("stacks", ""),
          h.Style({
            display: "flex",
            "flex-direction": "column",
            gap: "24px",
            "margin-top": "auto",
            padding: "12px",
          }),
        ],
        Array.map(levels, (row) =>
          h.keyed("div")(
            `level-${Array.headNonEmpty(row).level}`,
            [
              h.DataAttribute("level", `${Array.headNonEmpty(row).level}`),
              h.Style({
                "align-items": "flex-end",
                display: "flex",
                "flex-wrap": "wrap",
                gap: "12px",
              }),
            ],
            Array.map(row, (stack) =>
              stackView(trace, stack, current, hasCurrent, isShowingModels, maybeChain, h),
            ),
          ),
        ),
      ),
      h.div(
        [h.Class("base-bar"), h.DataAttribute("base-branch", trace.baseBranch)],
        [trace.baseBranch],
      ),
    ],
  );
};
