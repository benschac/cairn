import type { Cursor } from "@cairn/contract";
import {
  PanOnScrollMode,
  XYPanZoom,
  getViewportForBounds,
  pointToRendererPoint,
  rendererPointToPoint,
  type PanZoomInstance,
} from "@xyflow/system";
import {
  Array,
  Cause,
  Effect,
  Function,
  MutableRef,
  Number,
  Option,
  Order,
  Predicate,
  Queue,
  Record,
  Schema,
  Stream,
} from "effect";
import { Mount } from "foldkit";

import { MAX_ZOOM, MIN_ZOOM, Viewport, type Positions, type Rect } from "./geometry.ts";
import { Message } from "./message.ts";

/** Pixels of room Fit leaves around the content. */
export const FIT_PADDING = 24;

export const ORIGIN_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/** The messages the canvas mount sends. */
type CanvasMessage = typeof Message.MeasuredPane.Type | typeof Message.PannedOrZoomed.Type;

/** The CSS transform that puts the canvas layer at the viewport. Pair it with `transform-origin: 0 0`. */
export const transformOf = (viewport: Viewport): string =>
  `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;

/** The lowest start and highest end the rects reach along one axis. */
const extentOf = (
  rects: Array.NonEmptyReadonlyArray<Rect>,
  startOf: (rect: Rect) => number,
  endOf: (rect: Rect) => number,
): Readonly<{ start: number; end: number }> => ({
  end: Array.max(Array.map(rects, endOf), Order.Number),
  start: Array.min(Array.map(rects, startOf), Order.Number),
});

/** The smallest box around every measured node; none when nothing is measured. */
export const boundsOf = (positions: Positions): Option.Option<Rect> =>
  Array.match(Record.values(positions), {
    onEmpty: () => Option.none(),
    onNonEmpty: (rects) => {
      const horizontal = extentOf(
        rects,
        (rect) => rect.x,
        (rect) => rect.x + rect.width,
      );
      const vertical = extentOf(
        rects,
        (rect) => rect.y,
        (rect) => rect.y + rect.height,
      );
      return Option.some({
        height: vertical.end - vertical.start,
        width: horizontal.end - horizontal.start,
        x: horizontal.start,
        y: vertical.start,
      });
    },
  });

/**
 * The viewport that centres `bounds` in a pane, zoomed to fit but kept within the zoom limits.
 * When the zoom limit stops the bounds fitting along an axis, centring would push the start of the
 * content off the pane, so on that axis the start of the content sits at the pane's padding.
 */
export const fitViewport = (bounds: Rect, width: number, height: number): Viewport => {
  const centred = getViewportForBounds(bounds, width, height, MIN_ZOOM, MAX_ZOOM, FIT_PADDING);
  const { zoom } = centred;
  const fits = (size: number, pane: number) => size * zoom <= pane - 2 * FIT_PADDING;
  return {
    x: fits(bounds.width, width) ? centred.x : FIT_PADDING - bounds.x * zoom,
    y: fits(bounds.height, height) ? centred.y : FIT_PADDING - bounds.y * zoom,
    zoom,
  };
};

/** A point in pane pixels, to canvas coordinates: the point on the layer under that spot. */
export const toCanvas = (point: Cursor, viewport: Viewport): Cursor =>
  pointToRendererPoint(point, [viewport.x, viewport.y, viewport.zoom]);

/** A point in canvas coordinates, to pane pixels. The inverse of `toCanvas`. */
export const toScreen = (point: Cursor, viewport: Viewport): Cursor =>
  rendererPointToPoint(point, [viewport.x, viewport.y, viewport.zoom]);

/** Whether a point in window pixels is on the pane, edges included. */
const isOnPane = (pane: Rect) => (client: Cursor) =>
  Number.between(client.x, { maximum: pane.x + pane.width, minimum: pane.x }) &&
  Number.between(client.y, { maximum: pane.y + pane.height, minimum: pane.y });

/**
 * The cursor to send for a pointer at `client` (window pixels) over a pane at `pane`, in canvas
 * coordinates; none when the pointer is outside the pane.
 */
export const cursorOf = (client: Cursor, pane: Rect, viewport: Viewport): Option.Option<Cursor> =>
  Option.map(Option.liftPredicate(client, isOnPane(pane)), (point) =>
    toCanvas({ x: point.x - pane.x, y: point.y - pane.y }, viewport),
  );

const ViewportJson = Schema.fromJsonString(Viewport);

/** The pane carries the model's viewport in this attribute, and the mount reads it back. */
export const VIEWPORT_ATTRIBUTE = "data-viewport";

/** Encoding a Viewport to JSON cannot fail, so the view can write the attribute directly. */
export const viewportAttribute = (viewport: Viewport): string =>
  Schema.encodeSync(ViewportJson)(viewport);

/** The viewport in the pane attribute; none when it is missing or is not a viewport. */
export const viewportOfAttribute = (text: string | null): Option.Option<Viewport> =>
  Option.flatMap(Option.fromNullOr(text), Schema.decodeOption(ViewportJson));

export const sameViewport = Schema.toEquivalence(Viewport);

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
): Readonly<{ reported: ReadonlyArray<Viewport>; shouldSync: boolean }> =>
  Option.match(
    Array.findFirstIndex(reported, (viewport) => sameViewport(viewport, fromModel)),
    {
      onNone: () => ({ reported: [], shouldSync: true }),
      onSome: (at) => ({ reported: Array.drop(reported, at + 1), shouldSync: false }),
    },
  );

/** The viewport the model last gave the pane; the origin before it has given one. */
export const paneViewportOf = (pane: Element): Viewport =>
  Option.getOrElse(
    viewportOfAttribute(pane.getAttribute(VIEWPORT_ATTRIBUTE)),
    () => ORIGIN_VIEWPORT,
  );

const measuredPane = (width: number, height: number): CanvasMessage =>
  Message.MeasuredPane({ size: { height, width } });

/** Drag on the pane to pan and scroll to zoom; anything marked `nopan` (the nodes) keeps its clicks and its text selection. */
const PAN_ZOOM_OPTIONS = {
  connectionInProgress: false,
  lib: "cairn",
  noPanClassName: "nopan",
  noWheelClassName: "nowheel",
  onTransformChange: Function.constVoid,
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
};

/** What the library and the attribute watcher share while the pane is mounted. */
interface PanZoomState {
  /** Viewports the library reported that the model has not yet echoed back. */
  readonly reported: MutableRef.MutableRef<ReadonlyArray<Viewport>>;
  /** Whether the mount is moving the library itself, which then reports what the model has. */
  readonly isSyncing: MutableRef.MutableRef<boolean>;
}

/** XYPanZoom on the pane, reporting each pan and zoom it makes; destroyed when the scope closes. */
const attachPanZoom = (
  element: Element,
  queue: Queue.Queue<CanvasMessage, Cause.Done>,
  { reported, isSyncing }: PanZoomState,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const instance = XYPanZoom({
        domNode: element,
        maxZoom: MAX_ZOOM,
        minZoom: MIN_ZOOM,
        onDraggingChange: Function.constVoid,
        onPanZoom: (_event, viewport) => {
          if (!MutableRef.get(isSyncing)) {
            MutableRef.update(reported, (viewports) =>
              Array.takeRight(Array.append(viewports, viewport), REPORTED_LIMIT),
            );
            Queue.offerUnsafe(queue, Message.PannedOrZoomed({ viewport }));
          }
        },
        translateExtent: [
          [-Infinity, -Infinity],
          [Infinity, Infinity],
        ],
        viewport: paneViewportOf(element),
      });
      instance.update(PAN_ZOOM_OPTIONS);
      return instance;
    }),
    (instance) => Effect.sync(() => instance.destroy()),
  );

/**
 * Moves the library to each viewport the model writes to the pane attribute, unless the library
 * reported it first; disconnected when the scope closes.
 */
const watchViewportAttribute = (
  element: Element,
  panZoom: PanZoomInstance,
  { reported, isSyncing }: PanZoomState,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const watcher = new MutationObserver(() => {
        const viewport = paneViewportOf(element);
        const next = reconcile(MutableRef.get(reported), viewport);
        MutableRef.set(reported, next.reported);
        if (next.shouldSync) {
          MutableRef.set(isSyncing, true);
          // A DOM callback, not an Effect: the flag must drop even if the library throws.
          try {
            panZoom.syncViewport(viewport);
          } finally {
            MutableRef.set(isSyncing, false);
          }
        }
      });
      watcher.observe(element, { attributeFilter: [VIEWPORT_ATTRIBUTE], attributes: true });
      return watcher;
    }),
    (watcher) => Effect.sync(() => watcher.disconnect()),
  );

/**
 * Reports the pane's size now and whenever it changes; the observer disconnects when the scope
 * closes. Environments without `ResizeObserver` (jsdom) keep the first size.
 */
const observePaneSize = (element: Element, queue: Queue.Queue<CanvasMessage, Cause.Done>) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      const box = element.getBoundingClientRect();
      Queue.offerUnsafe(queue, measuredPane(box.width, box.height));
    });
    if (Predicate.hasProperty(globalThis, "ResizeObserver")) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const resizer = new ResizeObserver((entries) => {
            const maybeEntry = Array.head(entries);
            if (Option.isSome(maybeEntry)) {
              const { contentRect } = maybeEntry.value;
              Queue.offerUnsafe(queue, measuredPane(contentRect.width, contentRect.height));
            }
          });
          resizer.observe(element);
          return resizer;
        }),
        (resizer) => Effect.sync(() => resizer.disconnect()),
      );
    }
  });

/**
 * Pan and zoom on the canvas pane. The library reports each change as `PannedOrZoomed` and the pane's
 * size as `MeasuredPane`. Mount arguments are fixed when the element appears, so the model's
 * viewport reaches the mount through the pane's `data-viewport` attribute. The library, the
 * attribute watcher and the size observer are each released when the pane goes, even if a later
 * one fails to start.
 */
export const PanZoomCanvas = Mount.defineStream("PanZoomCanvas", {
  execute: ({ element }) =>
    Stream.callback<CanvasMessage>((queue) =>
      Effect.gen(function* () {
        const state: PanZoomState = {
          reported: MutableRef.make<ReadonlyArray<Viewport>>([]),
          isSyncing: MutableRef.make(false),
        };
        const panZoom = yield* attachPanZoom(element, queue, state);
        yield* watchViewportAttribute(element, panZoom, state);
        yield* observePaneSize(element, queue);
      }),
    ),
  messages: [Message.MeasuredPane, Message.PannedOrZoomed],
});
