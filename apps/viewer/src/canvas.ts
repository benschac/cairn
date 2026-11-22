import { PanOnScrollMode, XYPanZoom, getViewportForBounds } from "@xyflow/system";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Mount } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

import type { Positions, Rect } from "./curves.ts";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;

/** Pixels of room Fit leaves around the content. */
export const FIT_PADDING = 24;

/**
 * Where the canvas layer sits in its pane: `x` and `y` are the layer's offset in pane pixels and
 * `zoom` its scale. This is the viewport `@xyflow/system` reports, and the model holds it.
 */
export const Viewport = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  zoom: Schema.Finite.check(Schema.isBetween({ maximum: MAX_ZOOM, minimum: MIN_ZOOM })),
});
export type Viewport = typeof Viewport.Type;

/** The canvas pane's size in pixels. */
export const Size = Schema.Struct({
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type Size = typeof Size.Type;

export const originViewport: Viewport = { x: 0, y: 0, zoom: 1 };

/** The messages the canvas mount sends. `main.ts` adds them to the viewer's own union. */
export const canvasMessages = {
  MeasuredPane: { size: Size },
  PannedOrZoomed: { viewport: Viewport },
} as const;
const CanvasMessage = defineMessageUnion(canvasMessages);
type CanvasMessage = typeof CanvasMessage.Type;

/** The CSS transform that puts the canvas layer at the viewport. Pair it with `transform-origin: 0 0`. */
export const transformOf = (viewport: Viewport): string =>
  `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;

/** The smallest box around every measured node, or `null` when nothing is measured. */
export const boundsOf = (positions: Positions): Rect | null => {
  const rects = Object.values(positions);
  if (rects.length === 0) {
    return null;
  }
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { height: bottom - top, width: right - left, x: left, y: top };
};

/** The viewport that centres `bounds` in a pane, zoomed to fit but kept within the zoom limits. */
export const fitViewport = (bounds: Rect, width: number, height: number): Viewport =>
  getViewportForBounds(bounds, width, height, MIN_ZOOM, MAX_ZOOM, FIT_PADDING);

const ViewportJson = Schema.fromJsonString(Viewport);

/** The pane carries the model's viewport in this attribute, and the mount reads it back. */
export const VIEWPORT_ATTRIBUTE = "data-viewport";

export const viewportAttribute = (viewport: Viewport): string =>
  Schema.encodeSync(ViewportJson)(viewport);

export const viewportOfAttribute = (text: string | null): Viewport | null =>
  text === null ? null : Option.getOrNull(Schema.decodeOption(ViewportJson)(text));

const sameViewport = (a: Viewport, b: Viewport): boolean =>
  a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/** How many reported viewports the mount remembers while it waits for the model to catch up. */
const REPORTED_LIMIT = 64;

/**
 * The model reaches the pane a frame after the library reports a viewport, so while someone is
 * panning it is always a little behind. A viewport the library reported is not a change to apply:
 * it only acknowledges everything reported up to it. Any other viewport came from the model, such
 * as Fit, and the library has to be told.
 */
export const reconcile = (
  reported: ReadonlyArray<Viewport>,
  fromModel: Viewport,
): { readonly reported: ReadonlyArray<Viewport>; readonly sync: boolean } => {
  const at = reported.findIndex((viewport) => sameViewport(viewport, fromModel));
  return at === -1
    ? { reported: [], sync: true }
    : { reported: reported.slice(at + 1), sync: false };
};

/**
 * Gives `element` the library's pan and zoom and returns the function that takes it away. Drag on
 * the pane to pan and scroll to zoom; anything marked `nopan` (the nodes) keeps its clicks and its
 * text selection.
 */
const attach = (element: Element, send: (message: CanvasMessage) => void): (() => void) => {
  const read = (): Viewport =>
    viewportOfAttribute(element.getAttribute(VIEWPORT_ATTRIBUTE)) ?? originViewport;
  let reported: ReadonlyArray<Viewport> = [];
  let syncing = false;
  const panZoom = XYPanZoom({
    domNode: element,
    maxZoom: MAX_ZOOM,
    minZoom: MIN_ZOOM,
    onDraggingChange: () => undefined,
    onPanZoom: (_event, viewport) => {
      // A sync from the model reports itself back; the model already has it.
      if (!syncing) {
        reported = [...reported, viewport].slice(-REPORTED_LIMIT);
        send(CanvasMessage.PannedOrZoomed({ viewport }));
      }
    },
    translateExtent: [
      [-Infinity, -Infinity],
      [Infinity, Infinity],
    ],
    viewport: read(),
  });
  panZoom.update({
    connectionInProgress: false,
    lib: "cairn",
    noPanClassName: "nopan",
    noWheelClassName: "nowheel",
    onTransformChange: () => undefined,
    paneDragThreshold: 5,
    panActivationKeyPressed: false,
    panOnDrag: true,
    panOnScroll: false,
    panOnScrollMode: PanOnScrollMode.Free,
    panOnScrollSpeed: 0.5,
    preventScrolling: true,
    userSelectionActive: false,
    zoomActivationKeyPressed: false,
    zoomOnDoubleClick: false,
    zoomOnPinch: true,
    zoomOnScroll: true,
  });
  const watcher = new MutationObserver(() => {
    const viewport = read();
    const next = reconcile(reported, viewport);
    reported = next.reported;
    if (next.sync) {
      syncing = true;
      try {
        panZoom.syncViewport(viewport);
      } finally {
        syncing = false;
      }
    }
  });
  watcher.observe(element, { attributeFilter: [VIEWPORT_ATTRIBUTE], attributes: true });
  const sendSize = (width: number, height: number) =>
    send(CanvasMessage.MeasuredPane({ size: { height, width } }));
  const box = element.getBoundingClientRect();
  sendSize(box.width, box.height);
  const resizer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry !== undefined) {
            sendSize(entry.contentRect.width, entry.contentRect.height);
          }
        });
  resizer?.observe(element);
  return () => {
    watcher.disconnect();
    resizer?.disconnect();
    panZoom.destroy();
  };
};

/**
 * Pan and zoom on the canvas pane. The library reports each change as `PannedOrZoomed` and the pane's
 * size as `MeasuredPane`. Mount arguments are fixed when the element appears, so the model's
 * viewport reaches the mount through the pane's `data-viewport` attribute.
 */
export const PanZoomCanvas = Mount.defineStream("PanZoomCanvas", {
  execute: ({ element }) =>
    Stream.callback<CanvasMessage>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => attach(element, (message) => Queue.offerUnsafe(queue, message))),
        (detach) => Effect.sync(detach),
      ).pipe(Effect.flatMap(() => Effect.never)),
    ),
  messages: [CanvasMessage.MeasuredPane, CanvasMessage.PannedOrZoomed],
});
