import type { Participant, SectionId, Trace } from "@cairn/contract";
import { Array, Option } from "effect";
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html";

import { PanZoomCanvas, VIEWPORT_ATTRIBUTE, transformOf, viewportAttribute } from "../canvas.ts";
import type { Positions, Viewport } from "../geometry.ts";
import { litChainsOf, type Pin } from "../highlight.ts";
import { MeasureLayout } from "../layout.ts";
import { renderMarkdown, type Rendered } from "../markdown.ts";
import type { Message } from "../message.ts";
import { stackLayoutOf } from "../stacks.ts";
import type { Node } from "../trace.ts";
import { cursorsView } from "./cursorsView.ts";
import { edgesView } from "./edgesView.ts";
import {
  judgmentMarkViews,
  nodeAttributes,
  nodeButtonView,
  sectionBadgeViews,
} from "./nodeView.ts";
import { stacksView } from "./stacksView.ts";

type ColumnName = "prd" | "spec" | "stacks";

const COLUMN_LABEL = { prd: "PRD", spec: "Spec", stacks: "Stacks" } satisfies Record<
  ColumnName,
  string
>;

const columnView = (
  name: ColumnName,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.AriaLabel(COLUMN_LABEL[name]),
      h.DataAttribute("column", name),
      h.Style({ overflow: "visible" }),
    ],
    children,
  );

/** The page has its own h1, so a document's "# " heading renders as an h2. */
const HEADING_OFFSET = 1;

/**
 * The PRD, the spec and the stacks side by side, each section and task a node in the chain.
 *
 * Parsing the markdown dominates a render, so `columnsLazy` rebuilds this only when the trace,
 * the hovered node, the pins or `h` changes: not on a pan, a zoom, a cursor, a measurement or
 * the drawer. It takes the Model's own fields and derives the lit chains in here, because a fresh
 * array of them each render would never be reference-equal.
 */
const columnsGridView = (
  trace: Trace,
  maybeHovered: Option.Option<Node>,
  pins: ReadonlyArray<Pin>,
  h: HtmlBuilder<Message>,
): Html => {
  const lit = litChainsOf(trace, pins, maybeHovered);
  const sectionTitle = (sectionId: SectionId, title: Rendered): Rendered => [
    nodeButtonView({ id: sectionId, kind: "section" }, pins, title, h),
  ];
  const sectionAttributes = (sectionId: SectionId) =>
    nodeAttributes(lit, { id: sectionId, kind: "section" }, h);
  const sectionBadges = (sectionId: SectionId): ReadonlyArray<Html> =>
    sectionBadgeViews(trace, sectionId, h);
  const specSectionMarks = (sectionId: SectionId): ReadonlyArray<Html> =>
    Array.appendAll(
      sectionBadges(sectionId),
      judgmentMarkViews(trace, { id: sectionId, kind: "section" }, h),
    );
  return h.div(
    [
      h.Style({
        display: "grid",
        gap: "24px",
        "grid-template-columns": "480px 480px max-content",
      }),
    ],
    [
      columnView(
        "prd",
        [
          renderMarkdown(trace.prd.markdown, h, {
            attributesOf: sectionAttributes,
            decorate: sectionBadges,
            headingOffset: HEADING_OFFSET,
            wrapTitle: sectionTitle,
          }),
        ],
        h,
      ),
      columnView(
        "spec",
        [
          renderMarkdown(trace.spec.markdown, h, {
            attributesOf: sectionAttributes,
            decorate: specSectionMarks,
            headingOffset: HEADING_OFFSET,
            wrapTitle: sectionTitle,
          }),
        ],
        h,
      ),
      columnView("stacks", [stacksView(trace, lit, pins, h)], h),
    ],
  );
};

/** One slot: the columns are rendered at a single position. */
const columnsLazy = createLazy();

/** The layer holds everything that pans and zooms: the columns, their edges and the cursors. */
const canvasLayerView = (
  trace: Trace,
  positions: Positions,
  viewport: Viewport,
  maybeHovered: Option.Option<Node>,
  pins: ReadonlyArray<Pin>,
  isShowingAllCurves: boolean,
  others: ReadonlyArray<Participant>,
  h: HtmlBuilder<Message>,
): Html => {
  const lit = litChainsOf(trace, pins, maybeHovered);
  return h.div(
    [
      h.DataAttribute("canvas-layer", ""),
      h.OnMount(MeasureLayout()),
      h.Style({
        position: "relative",
        transform: transformOf(viewport),
        "transform-origin": "0 0",
        // The layer is as wide as its content; nothing in it scrolls or clips.
        width: "max-content",
      }),
    ],
    Array.appendAll(
      [
        columnsLazy(columnsGridView, [trace, maybeHovered, pins, h]),
        edgesView(trace, positions, stackLayoutOf(trace.tasks), lit, isShowingAllCurves, h),
      ],
      cursorsView(others, viewport.zoom, h),
    ),
  );
};

/** The columns and their edges, and the other participants' cursors, with each pinned chain lit in its colour and the hovered node's chain lit over them. */
export const canvasView = (
  trace: Trace,
  positions: Positions,
  viewport: Viewport,
  maybeHovered: Option.Option<Node>,
  pins: ReadonlyArray<Pin>,
  isShowingAllCurves: boolean,
  others: ReadonlyArray<Participant>,
  h: HtmlBuilder<Message>,
): Html => {
  // The canvas is the pane; the layer inside it holds everything that pans and zooms.
  return h.div(
    [
      h.Role("region"),
      h.AriaLabel("Trace canvas"),
      h.DataAttribute("canvas", ""),
      h.Attribute(VIEWPORT_ATTRIBUTE, viewportAttribute(viewport)),
      h.OnMount(PanZoomCanvas()),
      h.Style({
        height: "calc(100vh - 160px)",
        "min-height": "320px",
        overflow: "hidden",
        position: "relative",
      }),
    ],
    [
      canvasLayerView(
        trace,
        positions,
        viewport,
        maybeHovered,
        pins,
        isShowingAllCurves,
        others,
        h,
      ),
    ],
  );
};
