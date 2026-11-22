import type { Participant, SectionId, Trace } from "@cairn/contract";
import { Array, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { PanZoomCanvas, VIEWPORT_ATTRIBUTE, transformOf, viewportAttribute } from "../canvas.ts";
import type { Positions, Viewport } from "../geometry.ts";
import { MeasureLayout } from "../layout.ts";
import { renderMarkdown, type Rendered } from "../markdown.ts";
import type { Message } from "../message.ts";
import { chainOf, type Chain, type Node } from "../trace.ts";
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

/** The PRD, the spec and the stacks side by side, each section and task a node in the chain. */
const columnsGridView = (
  trace: Trace,
  maybeChain: Option.Option<Chain>,
  maybeSelected: Option.Option<Node>,
  h: HtmlBuilder<Message>,
): Html => {
  const sectionTitle = (sectionId: SectionId, title: Rendered): Rendered => [
    nodeButtonView({ id: sectionId, kind: "section" }, maybeSelected, title, h),
  ];
  const sectionAttributes = (sectionId: SectionId) =>
    nodeAttributes(maybeChain, { id: sectionId, kind: "section" }, h);
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
      columnView("stacks", [stacksView(trace, maybeChain, maybeSelected, h)], h),
    ],
  );
};

/** The layer holds everything that pans and zooms: the columns, their edges and the cursors. */
const canvasLayerView = (
  trace: Trace,
  positions: Positions,
  viewport: Viewport,
  maybeChain: Option.Option<Chain>,
  maybeSelected: Option.Option<Node>,
  others: ReadonlyArray<Participant>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
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
        columnsGridView(trace, maybeChain, maybeSelected, h),
        edgesView(trace, positions, maybeChain, h),
      ],
      cursorsView(others, viewport.zoom, h),
    ),
  );

/** The columns and their edges, and the other participants' cursors, with the chain of the hovered node, or else the selected one, highlighted. */
export const canvasView = (
  trace: Trace,
  positions: Positions,
  viewport: Viewport,
  maybeActive: Option.Option<Node>,
  maybeSelected: Option.Option<Node>,
  others: ReadonlyArray<Participant>,
  h: HtmlBuilder<Message>,
): Html => {
  // One chain per render: every node and edge reads it.
  const maybeChain = Option.map(maybeActive, (active) => chainOf(trace, active));
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
    [canvasLayerView(trace, positions, viewport, maybeChain, maybeSelected, others, h)],
  );
};
