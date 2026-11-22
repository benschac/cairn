import { Cursor } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Number, Option, Record, Schema, Struct } from "effect";

import {
  FIT_PADDING,
  boundsOf,
  cursorOf,
  fitViewport,
  reconcile,
  sameViewport,
  toCanvas,
  toScreen,
  transformOf,
  viewportAttribute,
  viewportOfAttribute,
} from "../src/canvas.ts";
import { MAX_ZOOM, MIN_ZOOM, Size, Viewport, type Positions } from "../src/geometry.ts";

const Pixels = Schema.Finite.check(Schema.isBetween({ maximum: 1e6, minimum: -1e6 }));
const Box = (size: { readonly maximum: number; readonly minimum: number }) =>
  Schema.Struct({
    height: Schema.Finite.check(Schema.isBetween(size)),
    width: Schema.Finite.check(Schema.isBetween(size)),
    x: Pixels,
    y: Pixels,
  });
// Small enough that, with its padding, a box always fits the pane at the lowest zoom.
const Bounds = Box({ maximum: 2000, minimum: 1 });
const Pane = Schema.Struct({
  height: Schema.Finite.check(Schema.isBetween({ maximum: 4000, minimum: 400 })),
  width: Schema.Finite.check(Schema.isBetween({ maximum: 4000, minimum: 400 })),
});
const Huge = Box({ maximum: 1e6, minimum: 1e5 });
const Small = Schema.Struct({
  height: Schema.Finite.check(Schema.isBetween({ maximum: 600, minimum: 100 })),
  width: Schema.Finite.check(Schema.isBetween({ maximum: 600, minimum: 100 })),
});

it.prop("transformOf translates by the offset and scales by the zoom", [Viewport], ([viewport]) => {
  const parsed = Option.map(
    Option.fromNullOr(/^translate\((.+)px, (.+)px\) scale\((.+)\)$/.exec(transformOf(viewport))),
    (match) => Array.getSomes(Array.map(Array.drop(match, 1), Number.parse)),
  );
  // A negative zero prints as "0", so compare with the sign of zero dropped.
  expect(parsed).toEqual(Option.some([viewport.x + 0, viewport.y + 0, viewport.zoom]));
});

it.prop(
  "fitting keeps the bounds inside the padded pane at a zoom within the limits",
  [Bounds, Pane],
  ([bounds, pane]) => {
    const fit = fitViewport(bounds, pane.width, pane.height);
    // The library floors the padding it measures, so it can land a pixel inside the padded box.
    const slack = 1 + 1e-6;
    expect(fit.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(fit.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    const left = bounds.x * fit.zoom + fit.x;
    const top = bounds.y * fit.zoom + fit.y;
    const right = left + bounds.width * fit.zoom;
    const bottom = top + bounds.height * fit.zoom;
    expect(left).toBeGreaterThanOrEqual(FIT_PADDING - slack);
    expect(top).toBeGreaterThanOrEqual(FIT_PADDING - slack);
    expect(right).toBeLessThanOrEqual(pane.width - FIT_PADDING + slack);
    expect(bottom).toBeLessThanOrEqual(pane.height - FIT_PADDING + slack);
    // Centred, whichever way the zoom was limited.
    expect(Math.abs((left + right) / 2 - pane.width / 2)).toBeLessThanOrEqual(slack);
    expect(Math.abs((top + bottom) / 2 - pane.height / 2)).toBeLessThanOrEqual(slack);
  },
);

it.prop("fitting never zooms in past the maximum, however small the bounds", [Pane], ([pane]) => {
  expect(fitViewport({ height: 1, width: 1, x: 0, y: 0 }, pane.width, pane.height).zoom).toBe(
    MAX_ZOOM,
  );
});

it.prop(
  "bounds too big for the pane are fitted at the minimum zoom, not smaller",
  [Huge, Small],
  ([bounds, pane]) => {
    expect(fitViewport(bounds, pane.width, pane.height).zoom).toBe(MIN_ZOOM);
  },
);

const Thin = Schema.Struct({
  height: Schema.Finite.check(Schema.isBetween({ maximum: 1e6, minimum: 1e5 })),
  width: Schema.Finite.check(Schema.isBetween({ maximum: 50, minimum: 1 })),
  x: Pixels,
  y: Pixels,
});

it.prop(
  "when the zoom limit stops the bounds fitting, their top and left sit at the pane's padding",
  [Huge, Small],
  ([bounds, pane]) => {
    const fit = fitViewport(bounds, pane.width, pane.height);
    expect(Math.abs(bounds.x * fit.zoom + fit.x - FIT_PADDING)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(bounds.y * fit.zoom + fit.y - FIT_PADDING)).toBeLessThanOrEqual(1e-6);
  },
);

it.prop(
  "bounds that are too tall but fit across are top aligned and still centred across",
  [Thin, Pane],
  ([bounds, pane]) => {
    const fit = fitViewport(bounds, pane.width, pane.height);
    expect(fit.zoom).toBe(MIN_ZOOM);
    expect(Math.abs(bounds.y * fit.zoom + fit.y - FIT_PADDING)).toBeLessThanOrEqual(1e-6);
    const middle = bounds.x * fit.zoom + fit.x + (bounds.width * fit.zoom) / 2;
    expect(Math.abs(middle - pane.width / 2)).toBeLessThanOrEqual(1 + 1e-6);
  },
);

it.prop("a viewport survives the pane attribute", [Viewport], ([viewport]) => {
  // JSON has no negative zero, so compare with the sign of zero dropped.
  expect(viewportOfAttribute(viewportAttribute(viewport))).toEqual(
    Option.some({ x: viewport.x + 0, y: viewport.y + 0, zoom: viewport.zoom }),
  );
});

it("the pane attribute refuses text that is not a viewport", () => {
  const refused = [
    null,
    "",
    "[]",
    '{"x":0,"y":0,"zoom":0}',
    '{"x":0,"y":0,"zoom":9}',
    '{"x":0,"y":0}',
  ];
  expect(Array.filter(refused, (text) => Option.isSome(viewportOfAttribute(text)))).toEqual([]);
});
it.prop("a viewport outside the zoom limits is not a Viewport", [Pixels], ([x]) => {
  const is = Schema.is(Viewport);
  expect(is({ x, y: 0, zoom: 1 })).toBe(true);
  expect(is({ x, y: 0, zoom: MAX_ZOOM * 1.01 })).toBe(false);
  expect(is({ x, y: 0, zoom: MIN_ZOOM / 2 })).toBe(false);
  expect(is({ x, y: 0, zoom: 0 })).toBe(false);
  expect(is({ x: NaN, y: 0, zoom: 1 })).toBe(false);
  expect(Schema.is(Size)({ height: -1, width: 10 })).toBe(false);
});

it.prop(
  "boundsOf covers every measured box, and nothing measured has no bounds",
  [Schema.Array(Bounds)],
  ([boxes]) => {
    const positions: Positions = Record.fromEntries(
      Array.map(boxes, (box, at) => [`n${at}`, box] as const),
    );
    const bounds = boundsOf(positions);
    Array.match(boxes, {
      onEmpty: () => expect(bounds).toEqual(Option.none()),
      onNonEmpty: (measured) => {
        const { height, width, x, y } = Option.getOrThrow(bounds);
        const outside = Array.filter(
          measured,
          (box) =>
            box.x < x ||
            box.y < y ||
            box.x + box.width > x + width + 1e-6 ||
            box.y + box.height > y + height + 1e-6,
        );
        expect(outside).toEqual([]);
        // And no bigger than it has to be: a box touches the left and the top.
        expect(Array.some(measured, (box) => box.x === x)).toBe(true);
        expect(Array.some(measured, (box) => box.y === y)).toBe(true);
      },
    });
  },
);

const Reported = Schema.NonEmptyArray(Viewport);

it.prop(
  "a viewport the library reported is acknowledged, with what came before it, and not applied",
  [Reported, Schema.Int.check(Schema.isBetween({ maximum: 63, minimum: 0 }))],
  ([reported, index]) => {
    const echoed = Option.getOrThrow(Array.get(reported, index % reported.length));
    // The first report equal to the echo, which may come before the one picked.
    const first = Option.getOrThrow(
      Array.findFirstIndex(reported, (viewport) => sameViewport(viewport, echoed)),
    );
    expect(reconcile(reported, echoed)).toEqual({
      reported: Array.drop(reported, first + 1),
      shouldSync: false,
    });
  },
);

it.prop(
  "a viewport the library never reported is applied, and forgets what was reported",
  [Reported, Viewport],
  ([reported, fromModel]) => {
    const wasReported = Array.containsWith(sameViewport)(reported, fromModel);
    if (wasReported) {
      return;
    }
    expect(reconcile(reported, fromModel)).toEqual({ reported: [], shouldSync: true });
  },
);

it.prop(
  "viewports are the same exactly when their offsets and zoom are",
  [Viewport, Viewport],
  ([a, b]) => {
    expect(sameViewport(a, a)).toBe(true);
    expect(sameViewport(a, b)).toBe(a.x === b.x && a.y === b.y && a.zoom === b.zoom);
  },
);

// A cursor within the pixels a window can reach.
const Point = Cursor.mapFields(() => ({ x: Pixels, y: Pixels }));
// Offsets a window can reach; an arbitrary finite offset loses all precision to rounding.
const Shown = Viewport.mapFields(Struct.assign({ x: Pixels, y: Pixels }));
const PaneBox = Box({ maximum: 2000, minimum: 1 });

it.prop("toScreen undoes toCanvas for any viewport", [Point, Shown], ([point, viewport]) => {
  const back = toScreen(toCanvas(point, viewport), viewport);
  expect(back.x).toBeCloseTo(point.x, 6);
  expect(back.y).toBeCloseTo(point.y, 6);
});

it.prop(
  "a pointer inside the pane sends its canvas point, and one outside sends nothing",
  [PaneBox, Shown, Point],
  ([pane, viewport, offset]) => {
    const inside = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
    const sent = Option.getOrThrow(cursorOf(inside, pane, viewport));
    const expected = toCanvas({ x: pane.width / 2, y: pane.height / 2 }, viewport);
    // Adding then subtracting the pane's offset can differ from the direct sum in the last bit.
    expect(sent.x).toBeCloseTo(expected.x, 4);
    expect(sent.y).toBeCloseTo(expected.y, 4);
    // A point past each edge, by at least a pixel.
    const outside = [
      { x: pane.x - 1 - Math.abs(offset.x), y: inside.y },
      { x: pane.x + pane.width + 1 + Math.abs(offset.x), y: inside.y },
      { x: inside.x, y: pane.y - 1 - Math.abs(offset.y) },
      { x: inside.x, y: pane.y + pane.height + 1 + Math.abs(offset.y) },
    ];
    expect(
      Array.filter(outside, (point) => Option.isSome(cursorOf(point, pane, viewport))),
    ).toStrictEqual([]);
  },
);
