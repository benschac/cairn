import type { Participant, SectionId, SectionPrefix, Trace } from "@cairn/contract";
import { Array, Match, Option, Record } from "effect";
import { createKeyedLazy, createLazy, type Html, type HtmlBuilder } from "foldkit/html";

import { PanZoomCanvas, VIEWPORT_ATTRIBUTE, transformOf, viewportAttribute } from "../canvas.ts";
import {
  DragState,
  Movable,
  OFFSETS_ATTRIBUTE,
  offsetStyleOf,
  offsetsAttribute,
  type Offsets,
} from "../drag.ts";
import type { Positions, Viewport } from "../geometry.ts";
import { litChainsOf, searchMatchOf, type Pin } from "../highlight.ts";
import { diagramView } from "../diagram.ts";
import { MeasureLayout } from "../layout.ts";
import { renderMarkdown, type Rendered } from "../markdown.ts";
import type { Message } from "../message.ts";
import type { Search } from "../search.ts";
import { stackLayoutOf } from "../stacks.ts";
import type { Node } from "../trace.ts";
import { cursorsView } from "./cursorsView.ts";
import { edgesView } from "./edgesView.ts";
import {
  judgmentMarkViews,
  markedTextView,
  nodeAttributes,
  nodeButtonView,
  sectionBadgeViews,
} from "./nodeView.ts";
import { moveBarView } from "./moveHandleView.ts";
import { stacksView } from "./stacksView.ts";

type ColumnName = SectionPrefix | "stacks";

const COLUMN_LABEL = { prd: "PRD", spec: "Spec", stacks: "Stacks" } satisfies Record.ReadonlyRecord<
  ColumnName,
  string
>;

const columnView = (
  name: ColumnName,
  style: Record.ReadonlyRecord<string, string>,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.AriaLabel(COLUMN_LABEL[name]),
      h.DataAttribute("column", name),
      h.Style(Record.union({ overflow: "visible" }, style, (_own, extra) => extra)),
    ],
    children,
  );

/** The page has its own h1, so a document's "# " heading renders as an h2. */
const HEADING_OFFSET = 1;

/**
 * The PRD's or the spec's markdown, each section a node in the chain.
 *
 * Rendering the markdown is the costly part of a render, so `documentLazy` rebuilds this only when
 * the trace, the hovered node, the pins, the search or `h` changes: not on a pan, a zoom, a cursor,
 * a measurement, the drawer or a move. A search changes how the columns look on every keystroke,
 * and the parsed markdown is kept (see `treeOf`), so a keystroke renders the columns again
 * without parsing them. It takes the Model's own fields and derives the lit chains in here,
 * because a fresh array of them each render would never be reference-equal.
 *
 * A section the search matched by its title shows that title as plain text with the matched
 * characters marked; the other headings keep their formatting.
 */
const documentBodyView = (
  document: SectionPrefix,
  trace: Trace,
  maybeHovered: Option.Option<Node>,
  pins: ReadonlyArray<Pin>,
  search: Search,
  h: HtmlBuilder<Message>,
): Html => {
  const lit = litChainsOf(trace, pins, search.maybeActive, maybeHovered);
  const sectionTitle = (sectionId: SectionId, title: Rendered): Rendered => {
    const node: Node = { id: sectionId, kind: "section" };
    return [
      nodeButtonView(
        node,
        pins,
        Option.match(
          Option.filter(searchMatchOf(search, node), (result) => result.field === "title"),
          {
            onNone: () => title,
            onSome: (result) => markedTextView(result.text, result.ranges, h),
          },
        ),
        h,
      ),
    ];
  };
  const sectionAttributes = (sectionId: SectionId) =>
    nodeAttributes(lit, search, { id: sectionId, kind: "section" }, h);
  const diagram = (source: string, key: string) => diagramView(h, source, key);
  const sectionBadges = (sectionId: SectionId): ReadonlyArray<Html> =>
    sectionBadgeViews(trace, sectionId, h);
  const specSectionMarks = (sectionId: SectionId): ReadonlyArray<Html> =>
    Array.appendAll(
      sectionBadges(sectionId),
      judgmentMarkViews(trace, { id: sectionId, kind: "section" }, h),
    );
  return Match.value(document).pipe(
    Match.withReturnType<Html>(),
    Match.when("prd", () =>
      renderMarkdown(trace.prd.markdown, h, {
        attributesOf: sectionAttributes,
        decorate: sectionBadges,
        diagramView: diagram,
        headingOffset: HEADING_OFFSET,
        wrapTitle: sectionTitle,
      }),
    ),
    Match.when("spec", () =>
      renderMarkdown(trace.spec.markdown, h, {
        attributesOf: sectionAttributes,
        decorate: specSectionMarks,
        diagramView: diagram,
        headingOffset: HEADING_OFFSET,
        wrapTitle: sectionTitle,
      }),
    ),
    Match.exhaustive,
  );
};

/** One slot per document, keyed by the document: each body is rendered at a single position. */
const documentLazy = createKeyedLazy();

/**
 * The stacks, rebuilt like a document body and also whenever any offset changes: it takes the whole
 * offsets record, so moving a document rebuilds the task cards too. That costs one render of the
 * cards per pointer move, which is cheap next to parsing markdown.
 */
const stacksColumnView = (
  trace: Trace,
  maybeHovered: Option.Option<Node>,
  pins: ReadonlyArray<Pin>,
  search: Search,
  offsets: Offsets,
  h: HtmlBuilder<Message>,
): Html =>
  stacksView(
    trace,
    litChainsOf(trace, pins, search.maybeActive, maybeHovered),
    pins,
    search,
    offsets,
    h,
  );

const stacksLazy = createLazy();

/** The file each document comes from, shown on the bar it is dragged by. */
const documentPathOf = (document: SectionPrefix, trace: Trace): string =>
  Match.value(document).pipe(
    Match.when("prd", () => trace.prd.path),
    Match.when("spec", () => trace.spec.path),
    Match.exhaustive,
  );

/** A document's column: the bar across its top that drags it, then its markdown, moved by its offset. */
const documentColumnView = (
  document: SectionPrefix,
  trace: Trace,
  maybeHovered: Option.Option<Node>,
  pins: ReadonlyArray<Pin>,
  search: Search,
  offsets: Offsets,
  h: HtmlBuilder<Message>,
): Html => {
  const movable = Movable.Document({ document });
  return columnView(
    document,
    offsetStyleOf(offsets, movable),
    [
      moveBarView(
        movable,
        `Move ${COLUMN_LABEL[document]}`,
        `${COLUMN_LABEL[document]} · ${documentPathOf(document, trace)}`,
        h,
      ),
      documentLazy(document, documentBodyView, [document, trace, maybeHovered, pins, search, h]),
    ],
    h,
  );
};

/** The PRD, the spec and the stacks side by side. */
const columnsGridView = (
  trace: Trace,
  maybeHovered: Option.Option<Node>,
  pins: ReadonlyArray<Pin>,
  search: Search,
  offsets: Offsets,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Style({
        display: "grid",
        gap: "24px",
        "grid-template-columns": "480px 480px max-content",
      }),
    ],
    [
      documentColumnView("prd", trace, maybeHovered, pins, search, offsets, h),
      documentColumnView("spec", trace, maybeHovered, pins, search, offsets, h),
      columnView(
        "stacks",
        {},
        [stacksLazy(stacksColumnView, [trace, maybeHovered, pins, search, offsets, h])],
        h,
      ),
    ],
  );

/**
 * While an item is dragged nothing on the canvas selects and the pointer shows a closed hand. The
 * layer is also marked `data-dragging`, which a rule in index.html uses to give every handle the
 * closed hand too, since each handle sets its own open-hand cursor.
 */
const dragStyleOf = (drag: DragState): Record.ReadonlyRecord<string, string> =>
  DragState.match(drag, {
    Dragging: () => ({ cursor: "grabbing", "user-select": "none" }),
    Idle: () => ({}),
    Released: () => ({}),
  });

/**
 * The layer holds everything that pans and zooms: the columns, their edges and the cursors. It
 * carries the offsets in an attribute so the layout mount re-measures after every move.
 */
const canvasLayerView = (
  trace: Trace,
  positions: Positions,
  viewport: Viewport,
  maybeHovered: Option.Option<Node>,
  pins: ReadonlyArray<Pin>,
  search: Search,
  isShowingAllCurves: boolean,
  offsets: Offsets,
  drag: DragState,
  others: ReadonlyArray<Participant>,
  h: HtmlBuilder<Message>,
): Html => {
  const lit = litChainsOf(trace, pins, search.maybeActive, maybeHovered);
  return h.div(
    Array.flatten([
      [
        h.DataAttribute("canvas-layer", ""),
        h.Attribute(OFFSETS_ATTRIBUTE, offsetsAttribute(offsets)),
        h.OnMount(MeasureLayout()),
      ],
      DragState.guards.Dragging(drag) ? [h.DataAttribute("dragging", "")] : [],
      [
        h.Style(
          Record.union(
            {
              position: "relative",
              transform: transformOf(viewport),
              "transform-origin": "0 0",
              // The layer is as wide as its content; nothing in it scrolls or clips.
              width: "max-content",
            },
            dragStyleOf(drag),
            (_own, dragging) => dragging,
          ),
        ),
      ],
    ]),
    Array.appendAll(
      [
        columnsGridView(trace, maybeHovered, pins, search, offsets, h),
        edgesView(trace, positions, stackLayoutOf(trace.tasks), lit, isShowingAllCurves, h),
      ],
      cursorsView(others, viewport.zoom, h),
    ),
  );
};

/**
 * The columns and their edges, and the other participants' cursors, with each pinned chain lit in
 * its colour, the active search result's chain over the pins and the hovered node's chain over
 * them all.
 */
export const canvasView = (
  trace: Trace,
  positions: Positions,
  viewport: Viewport,
  maybeHovered: Option.Option<Node>,
  pins: ReadonlyArray<Pin>,
  search: Search,
  isShowingAllCurves: boolean,
  offsets: Offsets,
  drag: DragState,
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
        // The pane is the whole screen: the toolbar and the drawer float over it.
        height: "100vh",
        left: "0",
        overflow: "hidden",
        position: "fixed",
        top: "0",
        width: "100vw",
      }),
    ],
    [
      canvasLayerView(
        trace,
        positions,
        viewport,
        maybeHovered,
        pins,
        search,
        isShowingAllCurves,
        offsets,
        drag,
        others,
        h,
      ),
    ],
  );
};
