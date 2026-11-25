import { expect, it } from "@effect/vitest";
import { Array, Schema, Struct } from "effect";

import { INITIAL_WIDTHS, Pane, deltaOf, draggedTo, limitsOf, resized } from "../src/panes.ts";

const Delta = Schema.Finite.check(Schema.isBetween({ maximum: 5000, minimum: -5000 }));
const Width = Schema.Finite.check(Schema.isBetween({ maximum: 3000, minimum: 0 }));
const AnyWidths = Schema.Struct({ detail: Width, prd: Width, spec: Width });

/** Widths with every pane already inside its limits. */
const InsideWidths = Schema.Struct({
  detail: Schema.Finite.check(Schema.isBetween({ maximum: 1800, minimum: 360 })),
  prd: Schema.Finite.check(Schema.isBetween({ maximum: 1600, minimum: 300 })),
  spec: Schema.Finite.check(Schema.isBetween({ maximum: 1600, minimum: 260 })),
});

const PANES: ReadonlyArray<Pane> = ["prd", "spec", "detail"];
const others = (pane: Pane) => Array.filter(PANES, (other) => other !== pane);

it("the limits are the spec's", () => {
  expect(limitsOf("prd")).toEqual({ max: 1600, min: 300 });
  expect(limitsOf("spec")).toEqual({ max: 1600, min: 260 });
  expect(limitsOf("detail")).toEqual({ max: 1800, min: 360 });
  expect(INITIAL_WIDTHS).toEqual({ detail: 600, prd: 520, spec: 440 });
});

it.prop(
  "resized never returns a width outside its pane's limits",
  [AnyWidths, Pane, Delta],
  ([widths, pane, delta]) => {
    const { max, min } = limitsOf(pane);
    const width = resized(widths, pane, delta)[pane];
    expect(width).toBeGreaterThanOrEqual(min);
    expect(width).toBeLessThanOrEqual(max);
  },
);

it.prop(
  "resized changes no pane but the one named",
  [AnyWidths, Pane, Delta],
  ([widths, pane, delta]) => {
    const after = resized(widths, pane, delta);
    expect(Struct.pick(after, others(pane))).toEqual(Struct.pick(widths, others(pane)));
  },
);

it.prop(
  "resized returns widths already inside their limits unchanged for a delta of zero",
  [InsideWidths, Pane],
  ([widths, pane]) => {
    expect(resized(widths, pane, 0)).toEqual(widths);
  },
);

it.prop(
  "a pane inside its limits moves by exactly the delta when the result stays inside",
  [InsideWidths, Pane, Delta],
  ([widths, pane, delta]) => {
    const { max, min } = limitsOf(pane);
    const wanted = widths[pane] + delta;
    expect(resized(widths, pane, delta)[pane]).toBe(Math.min(max, Math.max(min, wanted)));
  },
);

it.prop(
  "dragging sets the width at the press plus the travel, reversed for the detail panel",
  [InsideWidths, Pane, Width, Width, Width],
  ([widths, pane, startWidth, startX, x]) => {
    const { max, min } = limitsOf(pane);
    const travel = pane === "detail" ? startX - x : x - startX;
    const dragged = draggedTo(
      widths,
      { _tag: "Resizing", pane, pointerId: 1, startWidth, startX },
      x,
    );
    expect(dragged[pane]).toBe(Math.min(max, Math.max(min, startWidth + travel)));
    expect(Struct.pick(dragged, others(pane))).toEqual(Struct.pick(widths, others(pane)));
  },
);

it("a divider moved right narrows the detail panel and widens the others", () => {
  expect(deltaOf("detail", 10)).toBe(-10);
  expect(deltaOf("prd", 10)).toBe(10);
  expect(deltaOf("spec", -10)).toBe(-10);
});
