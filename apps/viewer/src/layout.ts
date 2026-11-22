import { AsyncData, Subscription } from "foldkit";
import { Array, Effect, Filter, Option, Predicate, Queue, Record, Schema, Stream } from "effect";

import { Positions, type Rect } from "./curves.ts";
import { Message } from "./main.ts";
import type { Model } from "./model.ts";

/** A measured element: its node key (the section or task id) and its box on screen. */
export type Measured = { readonly key: string; readonly rect: Rect };

/** A scale the layer can divide by: finite and above zero. */
const isUsableScale = Schema.is(Schema.Finite.check(Schema.isGreaterThan(0)));

/**
 * Canvas coordinates: each element's box relative to the layer, divided by the layer's scale so
 * that pan and zoom do not change them. A layer with no usable scale yields no positions.
 */
export const measure = (
  layerRect: Rect,
  scale: number,
  elements: ReadonlyArray<Measured>,
): Positions =>
  isUsableScale(scale)
    ? Record.fromIterableWith(elements, ({ key, rect }) => [
        key,
        {
          height: rect.height / scale,
          width: rect.width / scale,
          x: (rect.x - layerRect.x) / scale,
          y: (rect.y - layerRect.y) / scale,
        },
      ])
    : {};

const rectOf = (box: DOMRect): Rect => ({
  height: box.height,
  width: box.width,
  x: box.x,
  y: box.y,
});

const findLayer = (): Option.Option<Element> =>
  Option.fromNullOr(document.querySelector("[data-canvas-layer]"));

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

/** Every section and task in the layer, in canvas coordinates; none while the layer is absent. */
const measureLayer = (): Option.Option<Positions> =>
  Option.map(findLayer(), (layer) => {
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
  });

/** One tick on the next animation frame, after the first render has reached the DOM. */
const nextFrame = Stream.callback<void>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => requestAnimationFrame(() => Queue.offerUnsafe(queue, undefined))),
    (frame) => Effect.sync(() => cancelAnimationFrame(frame)),
  ),
);

/** A tick whenever the layer changes size. Environments without `ResizeObserver` never tick. */
const layerResized = Stream.suspend(() =>
  Option.match(
    Option.filter(findLayer(), () => Predicate.hasProperty(globalThis, "ResizeObserver")),
    {
      onNone: () => Stream.empty,
      onSome: (layer) =>
        Stream.callback<void>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const observer = new ResizeObserver(() => Queue.offerUnsafe(queue, undefined));
              observer.observe(layer);
              return observer;
            }),
            (observer) => Effect.sync(() => observer.disconnect()),
          ),
        ),
    },
  ),
);

/** A tick on every window resize. Lazy, so the module loads where there is no `window`. */
const windowResized = Stream.suspend(() => Stream.fromEventListener(window, "resize"));

const samePositions = Schema.toEquivalence(Positions);

/** The layer's positions on the first frame, on every window resize and whenever the layer resizes, when they changed. */
const layoutMessages = Stream.mergeAll([nextFrame, layerResized, windowResized], {
  concurrency: "unbounded",
}).pipe(
  Stream.filterMap(Filter.fromPredicateOption(measureLayer)),
  Stream.changesWith(samePositions),
  Stream.map((positions) => Message.MeasuredLayout({ positions })),
);

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  layout: entry(
    { traceLoaded: Schema.Boolean },
    {
      dependenciesToStream: ({ traceLoaded }) => (traceLoaded ? layoutMessages : Stream.empty),
      modelToDependencies: (model) => ({ traceLoaded: AsyncData.hasData(model.trace) }),
    },
  ),
}));
