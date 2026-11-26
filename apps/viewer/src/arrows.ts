import { Array, Match, Number, Option, Record, Schema } from "effect";

import type { Box } from "./boxes.ts";
import { ArrowLink } from "./boxes.ts";
import { Rect } from "./geometry.ts";
import type { Measured } from "./wires.ts";

/** The `data-wire` key of the stacks list: the origin the arrows are drawn from. */
export const STACKS_LIST_KEY = "stacks:list";

/** A point in the stacks list's own coordinates. */
export const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
export type Point = typeof Point.Type;

/** An arrow to draw: its keys, its kind, its end points and its SVG path, relative to the origin. */
export const Arrow = Schema.Struct({
  from: Point,
  kind: ArrowLink.fields.kind,
  path: Schema.String,
  source: Schema.String,
  target: Schema.String,
  to: Point,
});
export type Arrow = typeof Arrow.Type;

/** The least a control point sits out from its end, in pixels. */
const MIN_REACH = 8;

/** Where an arrow touches a rectangle, and the unit direction it leaves the rectangle in. */
interface End {
  readonly point: Point;
  readonly dx: number;
  readonly dy: number;
}

const topOf = (box: Rect): End => ({
  dx: 0,
  dy: -1,
  point: { x: box.x + box.width / 2, y: box.y },
});
const bottomOf = (box: Rect): End => ({
  dx: 0,
  dy: 1,
  point: { x: box.x + box.width / 2, y: box.y + box.height },
});
const leftOf = (box: Rect): End => ({
  dx: -1,
  dy: 0,
  point: { x: box.x, y: box.y + box.height / 2 },
});
const rightOf = (box: Rect): End => ({
  dx: 1,
  dy: 0,
  point: { x: box.x + box.width, y: box.y + box.height / 2 },
});

/** The two ends an arrow from `source` to `target` joins, by where the target lies. */
const endsOf = (source: Rect, target: Rect): readonly [End, End] =>
  Match.value({
    isAbove: target.y + target.height <= source.y,
    isBelow: target.y >= source.y + source.height,
    isRight: target.x + target.width / 2 >= source.x + source.width / 2,
  }).pipe(
    Match.when({ isAbove: true }, (): readonly [End, End] => [topOf(source), bottomOf(target)]),
    Match.when({ isBelow: true }, (): readonly [End, End] => [bottomOf(source), topOf(target)]),
    Match.when({ isRight: true }, (): readonly [End, End] => [rightOf(source), leftOf(target)]),
    Match.orElse((): readonly [End, End] => [leftOf(source), rightOf(target)]),
  );

const pathOf = (from: End, to: End): string => {
  // How far apart the ends are along the direction they leave in.
  const reach = Number.max(
    MIN_REACH,
    (Math.abs(to.point.x - from.point.x) * Math.abs(from.dx) +
      Math.abs(to.point.y - from.point.y) * Math.abs(from.dy)) /
      2,
  );
  const first = `${from.point.x + from.dx * reach},${from.point.y + from.dy * reach}`;
  const second = `${to.point.x + to.dx * reach},${to.point.y + to.dy * reach}`;
  return `M${from.point.x},${from.point.y} C${first} ${second} ${to.point.x},${to.point.y}`;
};

const shifted = (end: End, origin: Rect): End => ({
  ...end,
  point: { x: end.point.x - origin.x, y: end.point.y - origin.y },
});

/**
 * An arrow for each link whose two ends are both measured, in link order, in coordinates relative
 * to `origin`. `boxes` holds each key's rectangle in window coordinates.
 */
export const arrowsOf = (
  links: ReadonlyArray<ArrowLink>,
  boxes: Record.ReadonlyRecord<string, Rect>,
  origin: Rect,
): ReadonlyArray<Arrow> =>
  Array.getSomes(
    Array.map(links, ({ kind, source, target }) =>
      Option.map(
        Option.all([Record.get(boxes, source), Record.get(boxes, target)]),
        ([sourceBox, targetBox]) => {
          const [from, to] = endsOf(sourceBox, targetBox);
          const start = shifted(from, origin);
          const end = shifted(to, origin);
          return {
            from: start.point,
            kind,
            path: pathOf(start, end),
            source,
            target,
            to: end.point,
          };
        },
      ),
    ),
  );

/**
 * The arrows of every box, from the last `MeasuredWires`. Before the first, or while the list has
 * no rectangle, there are none.
 */
export const stackArrowsOf = (
  boxes: ReadonlyArray<Pick<Box, "arrows">>,
  maybeMeasured: Option.Option<Measured>,
): ReadonlyArray<Arrow> =>
  Option.match(maybeMeasured, {
    onNone: () => [],
    onSome: (measured) =>
      Option.match(Record.get(measured.boxes, STACKS_LIST_KEY), {
        onNone: () => [],
        onSome: (origin) =>
          arrowsOf(
            Array.flatMap(boxes, (box) => box.arrows),
            measured.boxes,
            origin,
          ),
      }),
  });
