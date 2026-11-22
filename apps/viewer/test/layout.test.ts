import { expect, it } from "@effect/vitest";
import { Array, Number, Option, Record, Schema, Struct } from "effect";

import { Rect, measure } from "../src/geometry.ts";

// Real screens stay far from the float limits, where sums overflow.
const Pixels = Schema.Finite.check(Schema.isBetween({ maximum: 1e6, minimum: -1e6 }));
// Every field of the measured Rect, each bounded to screen sizes.
const Box = Schema.Struct(Record.map(Rect.fields, () => Pixels));
const Offset = Schema.Struct({ x: Pixels, y: Pixels });
const Elements = Schema.Array(Schema.Struct({ key: Schema.String, rect: Box }));
const Scale = Schema.Finite.check(Schema.isBetween({ maximum: 8, minimum: 0.25 }));

const shifted = (rect: Rect, by: typeof Offset.Type): Rect =>
  Struct.evolve(rect, { x: (x) => x + by.x, y: (y) => y + by.y });

// Floats lose bits when added, so compare to a tolerance scaled to the magnitudes involved.
const near = (a: number, b: number, scale: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-6 * Number.max(1, Math.abs(scale)));

it.prop(
  "moving the layer and every element together leaves the positions unchanged",
  [Box, Elements, Offset, Scale],
  ([layer, elements, by, scale]) => {
    const here = measure(layer, scale, elements);
    const there = measure(
      shifted(layer, by),
      scale,
      Array.map(elements, ({ key, rect }) => ({ key, rect: shifted(rect, by) })),
    );
    expect(Record.keys(there)).toEqual(Record.keys(here));
    Array.forEach(Record.toEntries(here), ([key, rect]) => {
      const moved = Option.getOrThrow(Record.get(there, key));
      near(moved.x, rect.x, Number.max(Math.abs(by.x), Math.abs(rect.x)));
      near(moved.y, rect.y, Number.max(Math.abs(by.y), Math.abs(rect.y)));
    });
  },
);

it.prop(
  "the scale divides every coordinate and size",
  [Box, Elements, Scale],
  ([layer, elements, scale]) => {
    const unscaled = measure(layer, 1, elements);
    const scaled = measure(layer, scale, elements);
    expect(Record.keys(scaled)).toEqual(Record.keys(unscaled));
    Array.forEach(Record.toEntries(unscaled), ([key, rect]) => {
      const found = Option.getOrThrow(Record.get(scaled, key));
      near(found.x, rect.x / scale, rect.x);
      near(found.y, rect.y / scale, rect.y);
      near(found.width, rect.width / scale, rect.width);
      near(found.height, rect.height / scale, rect.height);
    });
  },
);

it("an element at the layer's corner sits at the origin", () => {
  const layer = { height: 500, width: 500, x: 40, y: 60 };
  expect(
    measure(layer, 2, [{ key: "t1", rect: { height: 20, width: 100, x: 40, y: 60 } }]),
  ).toEqual({
    t1: { height: 10, width: 50, x: 0, y: 0 },
  });
});

it.prop(
  "a layer with a zero or negative scale yields no positions",
  [Box, Elements, Schema.Finite.check(Schema.isLessThanOrEqualTo(0))],
  ([layer, elements, scale]) => {
    expect(measure(layer, scale, elements)).toEqual({});
  },
);

// A schema literal cannot be Infinity or NaN, so the non-finite scales are listed here.
it("an infinite or undefined scale yields no positions", () => {
  const layer = { height: 1, width: 1, x: 0, y: 0 };
  expect(
    Array.map([Infinity, -Infinity, NaN], (scale) =>
      measure(layer, scale, [{ key: "t1", rect: layer }]),
    ),
  ).toEqual([{}, {}, {}]);
});
