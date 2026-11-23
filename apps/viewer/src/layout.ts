import { Array, Effect, Option, Predicate, Queue, Record, Schema, Stream } from "effect";
import { Mount } from "foldkit";

import { OFFSETS_ATTRIBUTE } from "./drag.ts";
import { Positions, measure, rectOf, type Rect } from "./geometry.ts";
import { Message } from "./message.ts";

/**
 * The scale the layer is painted at, which is the viewport's zoom. Reading it from the element
 * rather than the model keeps it in step with the rects measured beside it: the model can be a
 * frame ahead of what has been painted. `measure` yields nothing for a scale it cannot use.
 */
const scaleOf = (layer: Element): number =>
  new DOMMatrixReadOnly(getComputedStyle(layer).transform).a;

/** The node key of a `[data-section]` or `[data-task]` element. */
const keyOf = (element: Element): Option.Option<string> =>
  Option.orElse(Option.fromNullOr(element.getAttribute("data-section")), () =>
    Option.fromNullOr(element.getAttribute("data-task")),
  );

/** Every section and task in the layer, in canvas coordinates. */
export const measureLayer = (layer: Element): Positions => {
  const elements = Array.getSomes(
    Array.map(
      Array.fromIterable(layer.querySelectorAll("[data-section], [data-task]")),
      (element) =>
        Option.map(keyOf(element), (key) => ({
          key,
          rect: rectOf(element.getBoundingClientRect()),
        })),
    ),
  );
  return measure(rectOf(layer.getBoundingClientRect()), scaleOf(layer), elements);
};

/**
 * The box of a searchable block of prose, in canvas coordinates, or none while the block is not on
 * the page or the layer has no usable scale. It is measured on demand, when a result is selected,
 * not with every section and task.
 */
export const measureBlock = (key: string): Option.Option<Rect> =>
  Option.flatMap(
    Option.all({
      block: Option.fromNullOr(document.querySelector(`[data-block="${key}"]`)),
      layer: Option.fromNullOr(document.querySelector("[data-canvas-layer]")),
    }),
    ({ block, layer }) =>
      Record.get(
        measure(rectOf(layer.getBoundingClientRect()), scaleOf(layer), [
          { key, rect: rectOf(block.getBoundingClientRect()) },
        ]),
        key,
      ),
  );

/** One tick on the next animation frame, after the render that mounted the layer has reached the DOM. */
const nextFrame = Stream.callback<void>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => requestAnimationFrame(() => Queue.offerUnsafe(queue, undefined))),
    (frame) => Effect.sync(() => cancelAnimationFrame(frame)),
  ),
);

/** A tick whenever the layer changes size. Environments without `ResizeObserver` never tick. */
const layerResized = (layer: Element): Stream.Stream<void> =>
  Predicate.hasProperty(globalThis, "ResizeObserver")
    ? Stream.callback<void>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const observer = new ResizeObserver(() => Queue.offerUnsafe(queue, undefined));
            observer.observe(layer);
            return observer;
          }),
          (observer) => Effect.sync(() => observer.disconnect()),
        ),
      )
    : Stream.empty;

/**
 * A tick whenever a document or task card moves. The view writes every offset to the layer's
 * offsets attribute, and a moved element changes no size, so neither resize observer sees a move.
 */
const itemsMoved = (layer: Element): Stream.Stream<void> =>
  Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const observer = new MutationObserver(() => Queue.offerUnsafe(queue, undefined));
        observer.observe(layer, { attributeFilter: [OFFSETS_ATTRIBUTE], attributes: true });
        return observer;
      }),
      (observer) => Effect.sync(() => observer.disconnect()),
    ),
  );

/** A tick on every window resize. Lazy, so the module loads where there is no `window`. */
const windowResized = Stream.suspend(() => Stream.fromEventListener(window, "resize"));

const samePositions = Schema.toEquivalence(Positions);

/**
 * The positions of every node in the layer it is mounted on: on the first frame after the layer
 * appears, on every window resize, whenever the layer resizes and whenever an item is moved, each
 * time they changed. A moved item's measured box includes its offset, so the curves follow it. The
 * layer is in the DOM when a Mount runs, so unlike a Subscription it has nothing to wait for.
 */
export const MeasureLayout = Mount.defineStream("MeasureLayout", {
  execute: ({ element }) =>
    Stream.mergeAll([nextFrame, layerResized(element), itemsMoved(element), windowResized], {
      concurrency: "unbounded",
    }).pipe(
      Stream.map(() => measureLayer(element)),
      Stream.changesWith(samePositions),
      Stream.map((positions) => Message.MeasuredLayout({ positions })),
    ),
  messages: [Message.MeasuredLayout],
});
