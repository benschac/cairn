import { expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  FIT_PADDING,
  MAX_ZOOM,
  MIN_ZOOM,
  Size,
  Viewport,
  boundsOf,
  fitViewport,
  reconcile,
  transformOf,
  viewportAttribute,
  viewportOfAttribute,
} from "../src/canvas.ts";
import type { Positions } from "../src/curves.ts";

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
  const match = /^translate\((.+)px, (.+)px\) scale\((.+)\)$/.exec(transformOf(viewport));
  // A negative zero prints as "0", so compare with the sign of zero dropped.
  expect(match?.slice(1).map(Number)).toEqual([viewport.x + 0, viewport.y + 0, viewport.zoom]);
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

it.prop("a viewport survives the pane attribute", [Viewport], ([viewport]) => {
  // JSON has no negative zero, so compare with the sign of zero dropped.
  expect(viewportOfAttribute(viewportAttribute(viewport))).toEqual({
    x: viewport.x + 0,
    y: viewport.y + 0,
    zoom: viewport.zoom,
  });
});

it("the pane attribute refuses text that is not a viewport", () => {
  expect(viewportOfAttribute(null)).toBeNull();
  expect(viewportOfAttribute("")).toBeNull();
  expect(viewportOfAttribute("[]")).toBeNull();
  expect(viewportOfAttribute('{"x":0,"y":0,"zoom":0}')).toBeNull();
  expect(viewportOfAttribute('{"x":0,"y":0,"zoom":9}')).toBeNull();
  expect(viewportOfAttribute('{"x":0,"y":0}')).toBeNull();
});

it.prop("a viewport outside the zoom limits is not a Viewport", [Pixels], ([x]) => {
  const is = Schema.is(Viewport);
  expect(is({ x, y: 0, zoom: 1 })).toBe(true);
  expect(is({ x, y: 0, zoom: MAX_ZOOM * 1.01 })).toBe(false);
  expect(is({ x, y: 0, zoom: MIN_ZOOM / 2 })).toBe(false);
  expect(is({ x, y: 0, zoom: 0 })).toBe(false);
  expect(is({ x: Number.NaN, y: 0, zoom: 1 })).toBe(false);
  expect(Schema.is(Size)({ height: -1, width: 10 })).toBe(false);
});

it.prop(
  "boundsOf covers every measured box, and nothing measured has no bounds",
  [Schema.Array(Bounds)],
  ([boxes]) => {
    const positions: Positions = Object.fromEntries(boxes.map((box, at) => [`n${at}`, box]));
    const bounds = boundsOf(positions);
    if (boxes.length === 0) {
      expect(bounds).toBeNull();
      return;
    }
    for (const box of boxes) {
      expect(bounds?.x ?? Infinity).toBeLessThanOrEqual(box.x);
      expect(bounds?.y ?? Infinity).toBeLessThanOrEqual(box.y);
      expect((bounds?.x ?? -Infinity) + (bounds?.width ?? 0)).toBeGreaterThanOrEqual(
        box.x + box.width - 1e-6,
      );
      expect((bounds?.y ?? -Infinity) + (bounds?.height ?? 0)).toBeGreaterThanOrEqual(
        box.y + box.height - 1e-6,
      );
    }
  },
);

const Reported = Schema.NonEmptyArray(Viewport);

it.prop(
  "a viewport the library reported is acknowledged, with what came before it, and not applied",
  [Reported, Schema.Int.check(Schema.isBetween({ maximum: 63, minimum: 0 }))],
  ([reported, index]) => {
    const at = index % reported.length;
    const echoed = reported[at];
    if (echoed === undefined) throw new Error("empty");
    const result = reconcile(reported, echoed);
    expect(result.sync).toBe(false);
    expect(result.reported).toEqual(reported.slice(reported.indexOf(echoed) + 1));
  },
);

it.prop(
  "a viewport the library never reported is applied, and forgets what was reported",
  [Reported, Viewport],
  ([reported, fromModel]) => {
    const unseen = reported.some(
      (viewport) =>
        viewport.x === fromModel.x &&
        viewport.y === fromModel.y &&
        viewport.zoom === fromModel.zoom,
    );
    if (unseen) {
      return;
    }
    expect(reconcile(reported, fromModel)).toEqual({ reported: [], sync: true });
  },
);
