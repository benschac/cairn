import { Schema } from "effect";

/** An element's box on screen, as measured from the DOM. */
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

/** An element's box on screen, as a Rect. */
export const rectOf = (box: DOMRect): Rect => ({
  height: box.height,
  width: box.width,
  x: box.x,
  y: box.y,
});
