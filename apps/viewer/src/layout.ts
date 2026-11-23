import { Array, Effect, Option, Predicate, Queue, Schema, Stream } from "effect";
import { Mount } from "foldkit";

import { OFFSETS_ATTRIBUTE } from "./drag.ts";
import { Positions, measure, rectOf } from "./geometry.ts";
import { Message } from "./message.ts";

/**
 * The scale the layer is painted at, which is the viewport's zoom. Reading it from the element
 * rather than the model keeps it in step with the rects measured beside it: the model can be a
 * frame ahead of what has been painted. `measure` yields nothing for a scale it cannot use.
 */
const scaleOf = (layer: Element): number =>
  new DOMMatrixReadOnly(getComputedStyle(layer).transform).a;

/**
 * The layer carries the keys of the prose blocks a search marked in this attribute. A block that
 * gains marks changes no size, so the layout mount re-measures when the attribute changes.
 */
export const BLOCKS_ATTRIBUTE = "data-blocks";

/** The key of a `[data-section]`, `[data-task]` or `[data-block]` element: a section or task ID, or a block's key. */
const keyOf = (element: Element): Option.Option<string> =>
  Option.orElse(
    Option.orElse(Option.fromNullOr(element.getAttribute("data-section")), () =>
      Option.fromNullOr(element.getAttribute("data-task")),
    ),
    () => Option.fromNullOr(element.getAttribute("data-block")),
  );

/** Every section, task and marked prose block in the layer, in canvas coordinates. */
export const measureLayer = (layer: Element): Positions => {
  const elements = Array.getSomes(
    Array.map(
      Array.fromIterable(layer.querySelectorAll("[data-section], [data-task], [data-block]")),
      (element) =>
        Option.map(keyOf(element), (key) => ({
          key,
          rect: rectOf(element.getBoundingClientRect()),
        })),
    ),
  );
  return measure(rectOf(layer.getBoundingClientRect()), scaleOf(layer), elements);
};

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
 * A tick whenever a document or task card moves or the marked blocks change. The view writes every
 * offset and the marked blocks to the layer's attributes, and neither changes a size, so neither
 * resize observer sees them.
 */
const itemsMoved = (layer: Element): Stream.Stream<void> =>
  Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const observer = new MutationObserver(() => Queue.offerUnsafe(queue, undefined));
        observer.observe(layer, {
          attributeFilter: [OFFSETS_ATTRIBUTE, BLOCKS_ATTRIBUTE],
          attributes: true,
        });
        return observer;
      }),
      (observer) => Effect.sync(() => observer.disconnect()),
    ),
  );

/** A tick on every window resize. Lazy, so the module loads where there is no `window`. */
const windowResized = Stream.suspend(() => Stream.fromEventListener(window, "resize"));

const samePositions = Schema.toEquivalence(Positions);

/**
 * The positions of every node in the layer it is mounted on, and of its marked prose blocks: on the
 * first frame after the layer appears, on every window resize, whenever the layer resizes and
 * whenever an item is moved or the marked blocks change, each
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
