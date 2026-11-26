import type { PrdSectionId, SectionStatus, TaskId, Trace, TraceTask } from "@cairn/contract";
import { labelOf, stacksOf, type Stack } from "@cairn/core/stacks";
import { Array, Effect, HashSet, Number, Option, Order, Record, String, pipe } from "effect";
import { Mount } from "foldkit";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { STACKS_LIST_KEY, dependencyLinksOf, stackArrowsOf } from "../arrows.ts";
import { stackBoxesOf, trunkLabelOf, type Box, type BoxCell, type Trunk } from "../boxes.ts";
import { Message } from "../message.ts";
import type { Focus } from "../model.ts";
import { currentTasksOf, planCountsOf, ranOf } from "../reader.ts";
import { nodeSearchOf } from "../highlight.ts";
import type { SearchResult } from "../search.ts";
import { Node, type Chain } from "../trace.ts";
import { dotView, labelView } from "../ui/marks.ts";
import {
  forkKey,
  hoverChainOf,
  isTaskDimmed,
  segmentKey,
  taskKey,
  type Measured,
} from "../wires.ts";
import { arrowsView } from "./arrowsView.ts";
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

/** The grid row of a chip row: each holds the chips and, under them, a gap row. Row 1 is the bottom. */
const gridRowOf = (rows: number, row: number): number => 2 * (rows - row) + 1;

/** A task's chip: a status dot and its ID, centred across the columns its `cell` spans. */
const chipView = (
  trace: Trace,
  task: TraceTask,
  cell: BoxCell,
  rows: number,
  current: HashSet.HashSet<string>,
  lit: HashSet.HashSet<TaskId>,
  hasCurrent: boolean,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  isLinked: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const ran = ranOf(task);
  const isLit = HashSet.has(lit, task.id);
  const search = nodeSearchOf(results, maybeActive, { id: task.id, kind: "task" });
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
          "grid-column": `${cell.column} / span ${cell.span}`,
          "grid-row": `${gridRowOf(rows, cell.row)}`,
          "justify-self": "center",
        }),
      ],
      hoverAttributesOf({ id: task.id, kind: "task" }, h),
      searchedAttributesOf(search, h),
      isShowingModels ? modelAttributesOf(ran, h) : [],
      isDone(task) ? [h.DataAttribute("done", "")] : [],
      task.gate.required ? [h.DataAttribute("gated", "")] : [],
      isCurrent ? [h.DataAttribute("current", "")] : [],
      isLinked ? [h.DataAttribute("linked", "")] : [],
      isLit ? [h.DataAttribute("lit", "")] : [],
      hasCurrent && !isCurrent && !isLit ? [h.DataAttribute("faded", "")] : [],
      isTaskDimmed(maybeChain, task.id) && !isLit ? [h.DataAttribute("dimmed", "")] : [],
    ]),
    Array.appendAll(
      Array.prepend(fieldView(search, "id", task.id, h), dotView(task.status, h)),
      isShowingModels ? [modelMarkView(ran, h)] : [],
    ),
  );
};

/** What a child of a fork is labelled, in the gap row under its chip and across its columns. */
const forkLabelView = (
  id: TaskId,
  text: string,
  cell: BoxCell,
  rows: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed("span")(
    `fork-${id}`,
    [
      h.Class("label"),
      h.DataAttribute("fork-label", ""),
      h.DataAttribute("wire", forkKey(id)),
      h.Style({
        "grid-column": `${cell.column} / span ${cell.span}`,
        "grid-row": `${gridRowOf(rows, cell.row) + 1}`,
        "justify-self": "center",
      }),
    ],
    [text],
  );

/**
 * The button under a box's grid that folds and unfolds its trunk. Folded, it stands for the trunk's
 * chips and is marked as a chip is, and as linked when a link focused it; unfolded, it is a slim
 * bar under the chips.
 */
const segmentView = (
  box: Box,
  trunk: Trunk,
  current: HashSet.HashSet<string>,
  lit: HashSet.HashSet<TaskId>,
  hasCurrent: boolean,
  maybeChain: Option.Option<Chain>,
  maybeSelected: Option.Option<Node>,
  isLinked: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const range = `${Array.headNonEmpty(trunk.tasks)}–${Array.lastNonEmpty(trunk.tasks)}`;
  const text = trunk.isFolded ? trunkLabelOf(box.stack, trunk) : `Fold ${range}`;
  const title = trunk.isFolded ? `${text} · click to unfold` : text;
  const isCurrent = Array.some(trunk.tasks, (id) => HashSet.has(current, id));
  const isSelected = Option.exists(maybeSelected, (node) =>
    Node.match(node, {
      section: () => false,
      task: ({ id }) => Array.contains(trunk.tasks, id),
    }),
  );
  const isLit = Array.some(trunk.tasks, (id) => HashSet.has(lit, id));
  const isDimmed =
    !isLit &&
    Option.exists(maybeChain, (chain) =>
      Array.every(trunk.tasks, (id) => !HashSet.has(chain.tasks, id)),
    );
  return h.keyed("button")(
    `segment-${trunk.root}`,
    Array.flatten([
      [
        h.Type("button"),
        h.Class("segment"),
        h.DataAttribute("segment", trunk.root),
        h.DataAttribute("holds", Array.join(trunk.tasks, " ")),
        h.DataAttribute("wire", segmentKey(trunk.root)),
        h.AriaExpanded(!trunk.isFolded),
        h.Title(title),
        h.AriaLabel(title),
        h.OnClick(Message.ClickedSegment({ root: trunk.root })),
      ],
      trunk.isFolded
        ? Array.flatten([
            isCurrent ? [h.DataAttribute("current", "")] : [],
            isLit ? [h.DataAttribute("lit", "")] : [],
            hasCurrent && !isCurrent && !isLit ? [h.DataAttribute("faded", "")] : [],
            isSelected ? [h.DataAttribute("selected", "")] : [],
            isDimmed ? [h.DataAttribute("dimmed", "")] : [],
            isLinked ? [h.DataAttribute("linked", "")] : [],
          ])
        : [],
    ]),
    trunk.isFolded ? [dotView("done", h), text] : [text],
  );
};

const stackView = (
  trace: Trace,
  box: Box,
  current: HashSet.HashSet<string>,
  lit: HashSet.HashSet<TaskId>,
  hasCurrent: boolean,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  maybeSelected: Option.Option<Node>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  maybeLinkFocus: Option.Option<Focus>,
  h: HtmlBuilder<Message>,
): Html => {
  const { stack } = box;
  // A link focused this box, by its stack or by its finished trunk. The box is outlined either
  // way. A folded trunk is marked as the segment, and an unfolded one as its chips, which then
  // stand for the segment.
  const maybeLinked = Option.filter(maybeLinkFocus, (focus) => focus.root === stack.root);
  const isSegmentLinked = Option.exists(maybeLinked, (focus) => focus.kind === "segment");
  const linkedTasks = Option.match(box.maybeTrunk, {
    onNone: () => [],
    onSome: (trunk) => (isSegmentLinked ? trunk.tasks : []),
  });
  const label = labelOf(stack);
  const columns = Array.reduce(Record.values(box.cells), 1, (last, cell) =>
    Number.max(last, cell.column + cell.span - 1),
  );
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
      Array.flatten([
        holdsCurrent(stack, current) ? [h.DataAttribute("current", "")] : [],
        Option.isSome(maybeLinked) ? [h.DataAttribute("linked", "")] : [],
      ]),
    ),
    Array.flatten([
      [
        h.div(
          [
            h.Class("stack-grid"),
            // A box whose every task is folded into its segment has no chip row.
            h.Style(
              box.rows > 0
                ? {
                    "grid-template-columns": `repeat(${columns}, minmax(var(--stack-column), auto))`,
                    "grid-template-rows": `repeat(${box.rows}, auto var(--stack-gap))`,
                  }
                : {},
            ),
          ],
          Array.flatMap(trace.tasks, (task) =>
            Array.match(Array.fromOption(Record.get(box.cells, task.id)), {
              onEmpty: () => [],
              onNonEmpty: ([cell]) =>
                Array.prepend(
                  Array.map(Array.fromOption(Record.get(box.forkLabels, task.id)), (text) =>
                    forkLabelView(task.id, text, cell, box.rows, h),
                  ),
                  chipView(
                    trace,
                    task,
                    cell,
                    box.rows,
                    current,
                    lit,
                    hasCurrent,
                    isShowingModels,
                    maybeChain,
                    results,
                    maybeActive,
                    Array.contains(linkedTasks, task.id),
                    h,
                  ),
                ),
            }),
          ),
        ),
      ],
      Array.map(Option.toArray(box.maybeTrunk), (trunk) =>
        segmentView(
          box,
          trunk,
          current,
          lit,
          hasCurrent,
          maybeChain,
          maybeSelected,
          isSegmentLinked,
          h,
        ),
      ),
      [h.div([h.Class("label"), h.DataAttribute("stack-label", "")], [`${stack.number}`])],
    ]),
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
  unfolded: Record.ReadonlyRecord<string, boolean>,
  maybeMeasured: Option.Option<Measured>,
  maybeSelected: Option.Option<Node>,
  maybeHovered: Option.Option<Node>,
  maybeFocus: Option.Option<TaskId>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  maybeLinkFocus: Option.Option<Focus>,
  h: HtmlBuilder<Message>,
): Html => {
  const current = currentTasksOf(trace, maybeCurrent);
  const maybeChain = hoverChainOf(trace, maybeHovered);
  const hasCurrent = Option.isSome(maybeCurrent);
  const boxes = stackBoxesOf(trace.tasks, unfolded);
  const dependencies = dependencyLinksOf(trace, boxes, maybeFocus);
  const levels = pipe(
    Array.groupBy(boxes, (box) => `${box.stack.level}`),
    Record.values,
    Array.sortWith((row) => Array.headNonEmpty(row).stack.level, Order.flip(Order.Number)),
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
        [
          h.Class("stacks-list"),
          h.DataAttribute("stacks", ""),
          h.DataAttribute("wire", STACKS_LIST_KEY),
        ],
        Array.prepend(
          Array.map(levels, (row) =>
            h.keyed("div")(
              `level-${Array.headNonEmpty(row).stack.level}`,
              [
                h.Class("stacks-level"),
                h.DataAttribute("level", `${Array.headNonEmpty(row).stack.level}`),
              ],
              Array.map(row, (box) =>
                stackView(
                  trace,
                  box,
                  current,
                  dependencies.lit,
                  hasCurrent,
                  isShowingModels,
                  maybeChain,
                  maybeSelected,
                  results,
                  maybeActive,
                  maybeLinkFocus,
                  h,
                ),
              ),
            ),
          ),
          arrowsView(
            stackArrowsOf(boxes, maybeMeasured, dependencies.links),
            maybeChain,
            dependencies.lit,
            h,
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
