import { Array, Effect, Option, Predicate, Queue, Schema, Stream } from "effect";
import { Mount } from "foldkit";

import { Positions, measure, rectOf } from "./geometry.ts";
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
const measureLayer = (layer: Element): Positions => {
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

/** A tick on every window resize. Lazy, so the module loads where there is no `window`. */
const windowResized = Stream.suspend(() => Stream.fromEventListener(window, "resize"));

const samePositions = Schema.toEquivalence(Positions);

/**
 * The positions of every node in the layer it is mounted on: on the first frame after the layer
 * appears, on every window resize and whenever the layer resizes, each time they changed. The
 * layer is in the DOM when a Mount runs, so unlike a Subscription it has nothing to wait for.
 */
export const MeasureLayout = Mount.defineStream("MeasureLayout", {
  execute: ({ element }) =>
    Stream.mergeAll([nextFrame, layerResized(element), windowResized], {
      concurrency: "unbounded",
    }).pipe(
      Stream.map(() => measureLayer(element)),
      Stream.changesWith(samePositions),
      Stream.map((positions) => Message.MeasuredLayout({ positions })),
    ),
  messages: [Message.MeasuredLayout],
});
