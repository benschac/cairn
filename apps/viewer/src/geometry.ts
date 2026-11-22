import { Record, Schema } from "effect";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;

/** A node's box in canvas coordinates, as measured from the DOM. */
export const Rect = Schema.Struct({
  height: Schema.Finite,
  width: Schema.Finite,
  x: Schema.Finite,
  y: Schema.Finite,
});
export type Rect = typeof Rect.Type;

/** Measured rects by node id: a section id for a `[data-section]` node, a task id for a `[data-task]` node. */
export const Positions = Schema.Record(Schema.String, Rect);
export type Positions = typeof Positions.Type;

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

/** A measured element: its node key (the section or task id) and its box on screen. */
export type Measured = Readonly<{ key: string; rect: Rect }>;

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

/** An element's box on screen, as a Rect. */
export const rectOf = (box: DOMRect): Rect => ({
  height: box.height,
  width: box.width,
  x: box.x,
  y: box.y,
});
