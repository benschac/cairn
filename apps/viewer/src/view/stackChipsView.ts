import type { PrdSectionId, SectionStatus, Trace, TraceTask } from "@cairn/contract";
import { Array, Effect, HashSet, Number, Option, Order, Record, String, pipe } from "effect";
import { Mount } from "foldkit";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../message.ts";
import { currentTasksOf, planCountsOf } from "../reader.ts";
import { labelOf, stacksOf, type Stack } from "../stacks.ts";
import { dotView, labelView } from "../ui/marks.ts";
import { branchStartOf } from "./stacksView.ts";

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
  h: HtmlBuilder<Message>,
): Html => {
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
        h.DataAttribute("wire", `task:${task.id}`),
        h.Title(title),
        h.AriaLabel(title),
        h.OnClick(Message.ClickedTask({ id: task.id })),
        h.Style({
          "grid-column": `${position.column}`,
          // A parent sits in the grid row below its child.
          "grid-row": `${topRow - position.row + 1}`,
        }),
      ],
      isDone(task) ? [h.DataAttribute("done", "")] : [],
      task.gate.required ? [h.DataAttribute("gated", "")] : [],
      isCurrent ? [h.DataAttribute("current", "")] : [],
      hasCurrent && !isCurrent ? [h.DataAttribute("faded", "")] : [],
    ]),
    [dotView(task.status, h), task.id],
  );
};

const stackView = (
  trace: Trace,
  stack: Stack,
  current: HashSet.HashSet<string>,
  hasCurrent: boolean,
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
          (task) => chipView(trace, task, stack, topRow, current, hasCurrent, h),
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

/** Over the diagram, held to the top of the pane: the count and the legend. */
const overviewView = (
  trace: Trace,
  current: HashSet.HashSet<string>,
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
        [
          labelView("Legend", h),
          swatchView("done", "done", [h.DataAttribute("done", "")], h),
          swatchView("pending", "pending", [], h),
          swatchView("in this section", "pending", [h.DataAttribute("current", "")], h),
          swatchView("a human gate", "blocked_on_human", [h.DataAttribute("gated", "")], h),
          h.span([], ["read up from main"]),
        ],
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
  h: HtmlBuilder<Message>,
): Html => {
  const current = currentTasksOf(trace, maybeCurrent);
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
      overviewView(trace, current, h),
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
            Array.map(row, (stack) => stackView(trace, stack, current, hasCurrent, h)),
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
