import { PanOnScrollMode, XYPanZoom, getViewportForBounds } from "@xyflow/system";
import {
  Array,
  Effect,
  Function,
  MutableRef,
  Option,
  Order,
  Predicate,
  Queue,
  Record,
  Schema,
  Stream,
} from "effect";
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

/** The smallest box around every measured node; none when nothing is measured. */
export const boundsOf = (positions: Positions): Option.Option<Rect> =>
  Array.match(Record.values(positions), {
    onEmpty: () => Option.none(),
    onNonEmpty: (rects) => {
      const left = Array.min(
        Array.map(rects, (rect) => rect.x),
        Order.Number,
      );
      const top = Array.min(
        Array.map(rects, (rect) => rect.y),
        Order.Number,
      );
      const right = Array.max(
        Array.map(rects, (rect) => rect.x + rect.width),
        Order.Number,
      );
      const bottom = Array.max(
        Array.map(rects, (rect) => rect.y + rect.height),
        Order.Number,
      );
      return Option.some({ height: bottom - top, width: right - left, x: left, y: top });
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
): { readonly reported: ReadonlyArray<Viewport>; readonly sync: boolean } =>
  Option.match(
    Array.findFirstIndex(reported, (viewport) => sameViewport(viewport, fromModel)),
    {
      onNone: () => ({ reported: [], sync: true }),
      onSome: (at) => ({ reported: Array.drop(reported, at + 1), sync: false }),
    },
  );

/** The viewport the model last gave the pane; the origin before it has given one. */
const paneViewportOf = (pane: Element): Viewport =>
  Option.getOrElse(
    viewportOfAttribute(pane.getAttribute(VIEWPORT_ATTRIBUTE)),
    () => originViewport,
  );

const paneSized = (width: number, height: number): CanvasMessage =>
  CanvasMessage.MeasuredPane({ size: { height, width } });

/** Drag on the pane to pan and scroll to zoom; anything marked `nopan` (the nodes) keeps its clicks and its text selection. */
const panZoomOptions = {
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
        // Viewports the library reported that the model has not yet echoed back.
        const reported = MutableRef.make<ReadonlyArray<Viewport>>([]);
        // Whether the mount is moving the library itself, which then reports what the model has.
        const syncing = MutableRef.make(false);
        const panZoom = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const instance = XYPanZoom({
              domNode: element,
              maxZoom: MAX_ZOOM,
              minZoom: MIN_ZOOM,
              onDraggingChange: Function.constVoid,
              onPanZoom: (_event, viewport) => {
                if (!MutableRef.get(syncing)) {
                  MutableRef.update(reported, (viewports) =>
                    Array.takeRight(Array.append(viewports, viewport), REPORTED_LIMIT),
                  );
                  Queue.offerUnsafe(queue, CanvasMessage.PannedOrZoomed({ viewport }));
                }
              },
              translateExtent: [
                [-Infinity, -Infinity],
                [Infinity, Infinity],
              ],
              viewport: paneViewportOf(element),
            });
            instance.update(panZoomOptions);
            return instance;
          }),
          (instance) => Effect.sync(() => instance.destroy()),
        );
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const watcher = new MutationObserver(() => {
              const viewport = paneViewportOf(element);
              const next = reconcile(MutableRef.get(reported), viewport);
              MutableRef.set(reported, next.reported);
              if (next.sync) {
                MutableRef.set(syncing, true);
                // A DOM callback, not an Effect: the flag must drop even if the library throws.
                try {
                  panZoom.syncViewport(viewport);
                } finally {
                  MutableRef.set(syncing, false);
                }
              }
            });
            watcher.observe(element, { attributeFilter: [VIEWPORT_ATTRIBUTE], attributes: true });
            return watcher;
          }),
          (watcher) => Effect.sync(() => watcher.disconnect()),
        );
        yield* Effect.sync(() => {
          const box = element.getBoundingClientRect();
          Queue.offerUnsafe(queue, paneSized(box.width, box.height));
        });
        // Environments without `ResizeObserver` (jsdom) keep the first size.
        if (Predicate.hasProperty(globalThis, "ResizeObserver")) {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const resizer = new ResizeObserver((entries) =>
                Option.match(Array.head(entries), {
                  onNone: Function.constVoid,
                  onSome: (entry) =>
                    Queue.offerUnsafe(
                      queue,
                      paneSized(entry.contentRect.width, entry.contentRect.height),
                    ),
                }),
              );
              resizer.observe(element);
              return resizer;
            }),
            (resizer) => Effect.sync(() => resizer.disconnect()),
          );
        }
      }),
    ),
  messages: [CanvasMessage.MeasuredPane, CanvasMessage.PannedOrZoomed],
});
