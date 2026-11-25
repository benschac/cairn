import type { PrdSectionId, SectionStatus, Trace, TraceTask } from "@cairn/contract";
import { labelOf, stacksOf, type Stack } from "@cairn/core/stacks";
import { Array, Effect, HashSet, Number, Option, Order, Record, String, pipe } from "effect";
import { Mount } from "foldkit";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../message.ts";
import { currentTasksOf, planCountsOf, ranOf } from "../reader.ts";
import { nodeSearchOf } from "../highlight.ts";
import type { SearchResult } from "../search.ts";
import type { Chain, Node } from "../trace.ts";
import { dotView, labelView } from "../ui/marks.ts";
import { hoverChainOf, isTaskDimmed, taskKey } from "../wires.ts";
import { modelAttributesOf, modelMarkView } from "./modelView.ts";
import { fieldView, searchedAttributesOf } from "./nodeView.ts";
import { branchStartOf } from "./stacksView.ts";
import { hoverAttributesOf } from "./wiresView.ts";

const isDone = (task: TraceTask): boolean => task.status === "done" || task.status === "landed";

/** A computed length in pixels, such as `10px`; zero when it is not one. */
const pixelsOf = (length: string): number =>
  Option.getOrElse(Number.parse(String.replace("px", "")(length)), () => 0);

/**
 * The width that lays every level of the chart out in one row: the widest level's stacks and the
 * gaps between them, plus the pane's side padding. None when the pane holds no level.
 */
const chartWidthOf = (pane: Element): Option.Option<number> => {
  const paneStyle = getComputedStyle(pane);
  const sides = pixelsOf(paneStyle.paddingLeft) + pixelsOf(paneStyle.paddingRight);
  return Option.map(
    Array.match(Array.fromIterable(pane.querySelectorAll(".stacks-level")), {
      onEmpty: () => Option.none<number>(),
      onNonEmpty: (levels) =>
        Option.some(
          Math.max(
            ...Array.map(levels, (level) => {
              const stacks = Array.fromIterable(level.children);
              const gap = pixelsOf(getComputedStyle(level).columnGap);
              return (
                Number.sumAll(Array.map(stacks, (stack) => stack.getBoundingClientRect().width)) +
                gap * Math.max(0, stacks.length - 1)
              );
            }),
          ),
        ),
    }),
    // Rounded up, with a pixel to spare, so rounding never wraps the widest level.
    (widest) => Math.ceil(widest + sides) + 1,
  );
};

/**
 * Scrolls the pane to the bottom, where the base branch bar is, and measures its chart. A Mount runs
 * once, when the pane is inserted, so the pane keeps whatever scroll a person gives it afterwards.
 */
export const ScrollStacksToBottom = Mount.define("ScrollStacksToBottom", {
  execute: ({ element }) =>
    Effect.sync(() => {
      element.scrollTop = element.scrollHeight;
      return Message.CompletedScrollStacks({ maybeChartWidth: chartWidthOf(element) });
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
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  h: HtmlBuilder<Message>,
): Html => {
  const ran = ranOf(task);
  const search = nodeSearchOf(results, maybeActive, { id: task.id, kind: "task" });
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
      searchedAttributesOf(search, h),
      isShowingModels ? modelAttributesOf(ran, h) : [],
      isDone(task) ? [h.DataAttribute("done", "")] : [],
      task.gate.required ? [h.DataAttribute("gated", "")] : [],
      isCurrent ? [h.DataAttribute("current", "")] : [],
      hasCurrent && !isCurrent ? [h.DataAttribute("faded", "")] : [],
      isTaskDimmed(maybeChain, task.id) ? [h.DataAttribute("dimmed", "")] : [],
    ]),
    Array.appendAll(
      Array.prepend(fieldView(search, "id", task.id, h), dotView(task.status, h)),
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
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
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
        [h.Class("stack-grid")],
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
              results,
              maybeActive,
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

const dotLegendView = (text: string, status: SectionStatus, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("stacks-legend-item")], [dotView(status, h), text]);

const swatchLegendView = (
  text: string,
  attributes: ReadonlyArray<Attribute<Message>>,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Class("stacks-legend-item")],
    [h.span(Array.prepend(attributes, h.Class("swatch"))), text],
  );

/** The legend's colours: the three models Cairn colours. */
const MODEL_ENTRIES: ReadonlyArray<string> = ["opus", "sonnet", "haiku"];

const modelLegendView = (model: string, h: HtmlBuilder<Message>): Html =>
  swatchLegendView(
    model,
    [
      h.DataAttribute("legend-model", model),
      h.DataAttribute("model", model),
      h.DataAttribute("ran", "true"),
    ],
    h,
  );

/** Over the diagram, held to the top of the pane: the count and the legend. */
const overviewView = (
  trace: Trace,
  current: HashSet.HashSet<string>,
  isShowingModels: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("stacks-top"), h.DataAttribute("stacks-summary", "")],
    [
      h.div([h.Class("col-head")], [labelView(`Stacks · ${summaryOf(trace, current)}`, h)]),
      h.div(
        [h.Class("stacks-legend"), h.DataAttribute("legend", "")],
        Array.flatten([
          [
            dotLegendView("done", "done", h),
            dotLegendView("pending", "pending", h),
            swatchLegendView("in this section", [h.DataAttribute("current", "")], h),
          ],
          isShowingModels
            ? Array.append(
                Array.map(MODEL_ENTRIES, (model) => modelLegendView(model, h)),
                h.span([], ["lo · med · hi · xhi = reasoning"]),
              )
            : [swatchLegendView("done", [h.DataAttribute("done", "")], h)],
          [
            h.span([h.Class("stacks-gate-note")], ["red = human gate"]),
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
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
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
      h.Class("stacks-pane"),
      h.Role("region"),
      h.AriaLabel("Stacks"),
      h.DataAttribute("stacks-pane", ""),
      h.OnMount(ScrollStacksToBottom()),
    ],
    [
      overviewView(trace, current, isShowingModels, h),
      h.div(
        [h.Class("stacks-list"), h.DataAttribute("stacks", "")],
        Array.map(levels, (row) =>
          h.keyed("div")(
            `level-${Array.headNonEmpty(row).level}`,
            [h.Class("stacks-level"), h.DataAttribute("level", `${Array.headNonEmpty(row).level}`)],
            Array.map(row, (stack) =>
              stackView(
                trace,
                stack,
                current,
                hasCurrent,
                isShowingModels,
                maybeChain,
                results,
                maybeActive,
                h,
              ),
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
