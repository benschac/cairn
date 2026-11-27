import type { PrdSectionId, SectionStatus, TaskId, Trace, TraceTask } from "@cairn/contract";
import { labelOf, stacksOf, type Stack } from "@cairn/core/stacks";
import { Mount as UiMount } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import {
  Array,
  Effect,
  HashSet,
  Number,
  Option,
  Order,
  Queue,
  Record,
  Stream,
  String,
  pipe,
} from "effect";

import { STACKS_LIST_KEY, dependencyLinksOf, stackArrowsOf } from "../arrows.ts";
import { stackBoxesOf, trunkLabelOf, type Box, type BoxCell, type Trunk } from "../boxes.ts";
import { styleText } from "../effect-ui/attributes.ts";
import { nodeSearchOf } from "../highlight.ts";
import { pathOfLink } from "../links.ts";
import { Message } from "../message.ts";
import type { Focus } from "../model.ts";
import { currentTasksOf, planCountsOf, ranOf, relationsOf } from "../reader.ts";
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
import { copyButtonView } from "./copyLinkView.ts";
import { withModel, modelMarkView } from "./modelView.ts";
import { fieldView, withSearched } from "./nodeView.ts";

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
export const ScrollStacksToBottom = UiMount.makeStream(
  "ScrollStacksToBottom",
  { args: {} },
  (element: HTMLElement) =>
    Stream.callback<Message>((queue) =>
      Effect.sync(() => {
        element.scrollTop = element.scrollHeight;
        Queue.offerUnsafe(
          queue,
          Message.CompletedScrollStacks({ maybeChartWidth: chartWidthOf(element) }),
        );
      }),
    ),
);

/** Where a branch's name starts once its `<feature>/` prefix is left off. */
export const branchStartOf = (feature: string, branch: string): number =>
  String.startsWith(`${feature}/`)(branch) ? String.length(feature) + 1 : 0;

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
  h: Html.H<Message>,
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
) => {
  const ran = ranOf(task);
  const isLit = HashSet.has(lit, task.id);
  const search = nodeSearchOf(results, maybeActive, { id: task.id, kind: "task" });
  const isCurrent = HashSet.has(current, task.id);
  const title = chipTitleOf(trace, task);
  const node: Node = { id: task.id, kind: "task" };
  const chip = withSearched(
    h.button
      .key(task.id)
      .attr("type", "button")
      .class("chip")
      .attr("data-task", task.id)
      .attr("data-wire", taskKey(task.id))
      .attr("title", title)
      .attr("aria-label", title)
      .on("click", Message.ClickedTask({ id: task.id }))
      // A node is hovered on pointer enter and on focus, and left on pointer leave and on blur.
      .on("mouseenter", Message.HoveredNode({ node }))
      .on("mouseleave", Message.LeftNode())
      .on("focus", Message.HoveredNode({ node }))
      .on("blur", Message.LeftNode())
      .attr(
        "style",
        styleText({
          "grid-column": `${cell.column} / span ${cell.span}`,
          "grid-row": `${gridRowOf(rows, cell.row)}`,
          "justify-self": "center",
        }),
      ),
    search,
  );
  return (isShowingModels ? withModel(chip, ran) : chip)
    .attrs({
      "data-done": isDone(task) ? "" : undefined,
      "data-gated": task.gate.required ? "" : undefined,
      "data-current": isCurrent ? "" : undefined,
      "data-linked": isLinked ? "" : undefined,
      "data-lit": isLit ? "" : undefined,
      "data-faded": hasCurrent && !isCurrent && !isLit ? "" : undefined,
      "data-dimmed": isTaskDimmed(maybeChain, task.id) && !isLit ? "" : undefined,
    })
    .children(
      dotView(h, task.status),
      fieldView(h, search, "id", task.id),
      isShowingModels && modelMarkView(h, ran),
    );
};

/** What a child of a fork is labelled, in the gap row under its chip and across its columns. */
const forkLabelView = (h: Html.H<Message>, id: TaskId, text: string, cell: BoxCell, rows: number) =>
  h.span
    .key(`fork-${id}`)
    .class("label")
    .attr("data-fork-label", "")
    .attr("data-wire", forkKey(id))
    .attr(
      "style",
      styleText({
        "grid-column": `${cell.column} / span ${cell.span}`,
        "grid-row": `${gridRowOf(rows, cell.row) + 1}`,
        "justify-self": "center",
      }),
    )
    .children(text);

/**
 * The button under a box's grid that folds and unfolds its trunk. Folded, it stands for the trunk's
 * chips and is marked as a chip is, and as linked when a link focused it; unfolded, it is a slim
 * bar under the chips.
 */
const segmentView = (
  h: Html.H<Message>,
  box: Box,
  trunk: Trunk,
  current: HashSet.HashSet<string>,
  lit: HashSet.HashSet<TaskId>,
  hasCurrent: boolean,
  maybeChain: Option.Option<Chain>,
  maybeSelected: Option.Option<Node>,
  isLinked: boolean,
) => {
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
  const { isFolded } = trunk;
  return h.button
    .key(`segment-${trunk.root}`)
    .attr("type", "button")
    .class("segment")
    .attr("data-segment", trunk.root)
    .attr("data-holds", Array.join(trunk.tasks, " "))
    .attr("data-wire", segmentKey(trunk.root))
    .attr("aria-expanded", `${!isFolded}`)
    .attr("title", title)
    .attr("aria-label", title)
    .on("click", Message.ClickedSegment({ root: trunk.root }))
    .attrs({
      "data-current": isFolded && isCurrent ? "" : undefined,
      "data-lit": isFolded && isLit ? "" : undefined,
      "data-faded": isFolded && hasCurrent && !isCurrent && !isLit ? "" : undefined,
      "data-selected": isFolded && isSelected ? "" : undefined,
      "data-dimmed": isFolded && isDimmed ? "" : undefined,
      "data-linked": isFolded && isLinked ? "" : undefined,
    })
    .children(isFolded && dotView(h, "done"), text);
};

/**
 * The box's Copy link buttons, in its corner: the stack, and its finished trunk when it has one,
 * which is when the trunk holds two or more tasks.
 */
const stackCopyView = (h: Html.H<Message>, box: Box, maybeCopiedLink: Option.Option<string>) =>
  h.div
    .class("stack-copy")
    .children(
      copyButtonView(
        h,
        maybeCopiedLink,
        pathOfLink([{ kind: "stack", root: box.stack.root }]),
        "Copy link",
      ),
      Option.isSome(box.maybeTrunk) &&
        copyButtonView(
          h,
          maybeCopiedLink,
          pathOfLink([{ kind: "segment", root: box.stack.root }]),
          "Copy link to finished trunk",
        ),
    );

const stackView = (
  h: Html.H<Message>,
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
  maybeCopiedLink: Option.Option<string>,
) => {
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
  return h.div
    .key(`stack-${stack.number}`)
    .class("stack")
    .attr("role", "group")
    .attr("title", label)
    .attr("aria-label", label)
    .attr("data-stack", `${stack.number}`)
    .attrs({
      "data-current": holdsCurrent(stack, current) ? "" : undefined,
      "data-linked": Option.isSome(maybeLinked) ? "" : undefined,
    })
    .children(
      h.div
        .class("stack-grid")
        // A box whose every task is folded into its segment has no chip row.
        .attr(
          "style",
          styleText(
            box.rows > 0
              ? {
                  "grid-template-columns": `repeat(${columns}, minmax(var(--stack-column), auto))`,
                  "grid-template-rows": `repeat(${box.rows}, auto var(--stack-gap))`,
                }
              : {},
          ),
        )
        .children(
          Array.flatMap(trace.tasks, (task) =>
            Array.match(Array.fromOption(Record.get(box.cells, task.id)), {
              onEmpty: () => [],
              onNonEmpty: ([cell]) =>
                Array.prepend(
                  Array.map(Array.fromOption(Record.get(box.forkLabels, task.id)), (text) =>
                    forkLabelView(h, task.id, text, cell, box.rows),
                  ),
                  chipView(
                    h,
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
                  ),
                ),
            }),
          ),
        ),
      Array.map(Option.toArray(box.maybeTrunk), (trunk) =>
        segmentView(
          h,
          box,
          trunk,
          current,
          lit,
          hasCurrent,
          maybeChain,
          maybeSelected,
          isSegmentLinked,
        ),
      ),
      h.div.class("label").attr("data-stack-label", "").children(`${stack.number}`),
      stackCopyView(h, box, maybeCopiedLink),
    );
};

/** "N of M stacks hold this section · X of Y tasks done". */
export const summaryOf = (trace: Trace, current: HashSet.HashSet<string>): string => {
  const stacks = stacksOf(trace.tasks, relationsOf(trace));
  const counts = planCountsOf(trace);
  const holding = Array.length(Array.filter(stacks, (stack) => holdsCurrent(stack, current)));
  return `${holding} of ${Array.length(stacks)} stacks hold this section · ${counts.done} of ${counts.tasks} tasks done`;
};

const dotLegendView = (h: Html.H<Message>, text: string, status: SectionStatus) =>
  h.span.class("stacks-legend-item").children(dotView(h, status), text);

const swatchLegendView = (
  h: Html.H<Message>,
  text: string,
  attributes: Record.ReadonlyRecord<string, string>,
) => h.span.class("stacks-legend-item").children(h.span.class("swatch").attrs(attributes), text);

/** The legend's colours: the three models Cairn colours. */
const MODEL_ENTRIES: ReadonlyArray<string> = ["opus", "sonnet", "haiku"];

const modelLegendView = (h: Html.H<Message>, model: string) =>
  swatchLegendView(h, model, {
    "data-legend-model": model,
    "data-model": model,
    "data-ran": "true",
  });

/** Over the diagram, held to the top of the pane: the count and the legend. */
const overviewView = (
  h: Html.H<Message>,
  trace: Trace,
  current: HashSet.HashSet<string>,
  isShowingModels: boolean,
) =>
  h.div
    .class("stacks-top")
    .attr("data-stacks-summary", "")
    .children(
      h.div.class("col-head").children(labelView(h, `Stacks · ${summaryOf(trace, current)}`)),
      h.div
        .class("stacks-legend")
        .attr("data-legend", "")
        .children(
          dotLegendView(h, "done", "done"),
          dotLegendView(h, "pending", "pending"),
          swatchLegendView(h, "in this section", { "data-current": "" }),
          isShowingModels
            ? Array.append(
                Array.map(MODEL_ENTRIES, (model) => modelLegendView(h, model)),
                h.span("lo · med · hi · xhi = reasoning"),
              )
            : swatchLegendView(h, "done", { "data-done": "" }),
          h.span.class("stacks-gate-note").children("red = human gate"),
          h.span("read up from main"),
        ),
    );

/**
 * The stacks pane: every stack, whatever the current section is. The levels are stacked bottom to
 * top, the highest at the top, each a row of its stacks in number order and aligned to the bottom,
 * over a bar labelled with the base branch that stays at the bottom of the pane. The bar is not a
 * node: nothing hovers it and no curve runs to it.
 */
export const stackChipsView = (
  h: Html.H<Message>,
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
  maybeCopiedLink: Option.Option<string>,
) => {
  const current = currentTasksOf(trace, maybeCurrent);
  const maybeChain = hoverChainOf(trace, maybeHovered);
  const hasCurrent = Option.isSome(maybeCurrent);
  const boxes = stackBoxesOf(trace.tasks, unfolded, relationsOf(trace));
  const dependencies = dependencyLinksOf(trace, boxes, maybeFocus);
  const levels = pipe(
    Array.groupBy(boxes, (box) => `${box.stack.level}`),
    Record.values,
    Array.sortWith((row) => Array.headNonEmpty(row).stack.level, Order.flip(Order.Number)),
  );
  return h.div
    .class("stacks-pane")
    .attr("role", "region")
    .attr("aria-label", "Stacks")
    .attr("data-stacks-pane", "")
    .onMount(ScrollStacksToBottom())
    .children(
      overviewView(h, trace, current, isShowingModels),
      h.div
        .class("stacks-list")
        .attr("data-stacks", "")
        .attr("data-wire", STACKS_LIST_KEY)
        .children(
          arrowsView(
            stackArrowsOf(boxes, maybeMeasured, dependencies.links),
            maybeChain,
            dependencies.lit,
          ),
          Array.map(levels, (row) =>
            h.div
              .key(`level-${Array.headNonEmpty(row).stack.level}`)
              .class("stacks-level")
              .attr("data-level", `${Array.headNonEmpty(row).stack.level}`)
              .children(
                Array.map(row, (box) =>
                  stackView(
                    h,
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
                    maybeCopiedLink,
                  ),
                ),
              ),
          ),
        ),
      h.div.class("base-bar").attr("data-base-branch", trace.baseBranch).children(trace.baseBranch),
    );
};
