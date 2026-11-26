import { expect, it } from "@effect/vitest";
import { Array, Option, Record, Schema } from "effect";

import { ArrowLink } from "../src/boxes.ts";
import { arrowsOf } from "../src/arrows.ts";
import type { Rect } from "../src/geometry.ts";

const Coordinate = Schema.Int.check(Schema.isBetween({ maximum: 600, minimum: -600 }));
const Size = Schema.Int.check(Schema.isBetween({ maximum: 120, minimum: 1 }));
const RectOf = Schema.Struct({ height: Size, width: Size, x: Coordinate, y: Coordinate });
/** Four keys that can be measured and a fifth, "e", that never is. */
const Measured = Schema.Struct({ a: RectOf, b: RectOf, c: RectOf, d: RectOf });
const Key = Schema.Literals(["a", "b", "c", "d", "e"]);
const Link = Schema.Struct({
  kind: Schema.Literals(["parent", "dependency"]),
  source: Key,
  target: Key,
});
const Links = Schema.Array(Link);
const Shift = Schema.Struct({ x: Coordinate, y: Coordinate });

/** The measured keys as the plain record `arrowsOf` takes. */
const boxesOf = (input: typeof Measured.Type): Record.ReadonlyRecord<string, Rect> => input;

const links = (input: ReadonlyArray<typeof Link.Type>): ReadonlyArray<ArrowLink> => input;

/** Whether the point is on the rectangle's boundary. */
const isOnEdge = (point: { x: number; y: number }, box: Rect): boolean => {
  const isInside =
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height;
  const isOnSide =
    point.x === box.x ||
    point.x === box.x + box.width ||
    point.y === box.y ||
    point.y === box.y + box.height;
  return isInside && isOnSide;
};

const moved = (box: Rect, by: { x: number; y: number }): Rect => ({
  ...box,
  x: box.x + by.x,
  y: box.y + by.y,
});

it.prop(
  "every arrow starts on an edge of its source's rectangle and ends on an edge of its target's, relative to the origin",
  [Links, Measured, RectOf],
  ([input, measured, origin]) => {
    const boxes = boxesOf(measured);
    Array.forEach(arrowsOf(links(input), boxes, origin), (arrow) => {
      const source = Option.getOrThrow(Record.get(boxes, arrow.source));
      const target = Option.getOrThrow(Record.get(boxes, arrow.target));
      expect(isOnEdge(arrow.from, moved(source, { x: -origin.x, y: -origin.y }))).toBe(true);
      expect(isOnEdge(arrow.to, moved(target, { x: -origin.x, y: -origin.y }))).toBe(true);
    });
  },
);

it.prop(
  "a link with an end not measured gives no arrow, and the others come in link order",
  [Links, Measured, RectOf],
  ([input, measured, origin]) => {
    const boxes = boxesOf(measured);
    expect(
      Array.map(arrowsOf(links(input), boxes, origin), (arrow) => [
        arrow.kind,
        arrow.source,
        arrow.target,
      ]),
    ).toEqual(
      Array.map(
        Array.filter(
          input,
          (link) => Record.has(boxes, link.source) && Record.has(boxes, link.target),
        ),
        (link) => [link.kind, link.source, link.target],
      ),
    );
  },
);

it.prop(
  "moving every rectangle and the origin by one offset gives the same arrows",
  [Links, Measured, RectOf, Shift],
  ([input, measured, origin, shift]) => {
    const boxes = boxesOf(measured);
    expect(
      arrowsOf(
        links(input),
        Record.map(boxes, (box) => moved(box, shift)),
        moved(origin, shift),
      ),
    ).toEqual(arrowsOf(links(input), boxes, origin));
  },
);

it("an arrow runs from the top of a lower source to the bottom of an upper target", () => {
  const [arrow] = arrowsOf(
    [{ kind: "parent", source: "low", target: "high" }],
    {
      high: { height: 20, width: 40, x: 100, y: 10 },
      low: { height: 20, width: 40, x: 100, y: 80 },
    },
    { height: 0, width: 0, x: 0, y: 0 },
  );
  expect(arrow?.from).toEqual({ x: 120, y: 80 });
  expect(arrow?.to).toEqual({ x: 120, y: 30 });
  expect(arrow?.path).toBe("M120,80 C120,55 120,55 120,30");
});

it("two rectangles level with each other are joined at their facing sides", () => {
  const [arrow] = arrowsOf(
    [{ kind: "parent", source: "left", target: "right" }],
    {
      left: { height: 20, width: 40, x: 0, y: 0 },
      right: { height: 20, width: 40, x: 100, y: 5 },
    },
    { height: 0, width: 0, x: 0, y: 0 },
  );
  expect(arrow?.from).toEqual({ x: 40, y: 10 });
  expect(arrow?.to).toEqual({ x: 100, y: 15 });
});
