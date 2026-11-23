import type { Trace } from "@cairn/contract";
import { Array, Option, Record, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { curvesOf, type Curve, type EdgeKind } from "../curves.ts";
import type { Positions } from "../geometry.ts";
import { PIN_PALETTE, pinColorsOf, type LitChain } from "../highlight.ts";
import type { Message } from "../message.ts";
import { isInChain } from "../trace.ts";

const EDGE_COLOR = {
  dependency: "#b45309",
  implements: "#64748b",
  parent: "#334155",
  specifies: "#0f766e",
} satisfies Record.ReadonlyRecord<EdgeKind, string>;

/** The lit chains holding both ends of a curve, bottom to top. */
const chainsHoldingCurve = (lit: ReadonlyArray<LitChain>, curve: Curve): ReadonlyArray<LitChain> =>
  Array.filter(
    lit,
    ({ chain }) => isInChain(chain, curve.source) && isInChain(chain, curve.target),
  );

/**
 * One curve's path. In a lit chain it is highlighted, in the colour of the top pin holding it, or
 * in its kind's colour when only the hovered chain holds it. Outside every lit chain it is dimmed,
 * and with nothing lit it is plain.
 */
const edgeView = (curve: Curve, lit: ReadonlyArray<LitChain>, h: HtmlBuilder<Message>): Html => {
  const holding = chainsHoldingCurve(lit, curve);
  const isHighlighted = Array.isReadonlyArrayNonEmpty(holding);
  const isDimmed = Array.isReadonlyArrayNonEmpty(lit) && !isHighlighted;
  const maybePinColor = Array.last(pinColorsOf(holding));
  return h.path(
    Array.flatten([
      [h.DataAttribute("edge", curve.id), h.DataAttribute("kind", curve.kind)],
      isHighlighted ? [h.DataAttribute("highlighted", "true")] : [],
      isDimmed ? [h.DataAttribute("dimmed", "true")] : [],
      Array.fromOption(Option.map(maybePinColor, (color) => h.DataAttribute("pin", color))),
      [
        h.D(curve.path),
        h.Fill("none"),
        h.Stroke(
          Option.match(maybePinColor, {
            onNone: () => EDGE_COLOR[curve.kind],
            onSome: (color) => PIN_PALETTE[color].stroke,
          }),
        ),
        h.StrokeWidth(isHighlighted ? "2.5" : "1.5"),
        h.Opacity(isDimmed ? "0.15" : "1"),
      ],
      curve.dashed ? [h.StrokeDasharray("6 4")] : [],
    ]),
  );
};

/**
 * One SVG path per curve between measured nodes. Only the curves of lit chains are drawn, the
 * pinned ones and the hovered one, so the canvas shows no curves until a node is pinned or
 * hovered. With `isShowingAllCurves` every curve is drawn and those outside the lit chains are
 * dimmed. Lit curves are drawn last, so they sit on top.
 */
export const edgesView = (
  trace: Trace,
  positions: Positions,
  lit: ReadonlyArray<LitChain>,
  isShowingAllCurves: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const curves = curvesOf(trace, positions);
  const isLitCurve = (curve: Curve) =>
    Array.isReadonlyArrayNonEmpty(chainsHoldingCurve(lit, curve));
  const inLitChain = Array.filter(curves, isLitCurve);
  const unlit = isShowingAllCurves ? Array.filter(curves, (curve) => !isLitCurve(curve)) : [];
  return h.svg(
    [
      h.DataAttribute("edges", ""),
      // The edges only draw the links the nodes' highlight already shows.
      h.AriaHidden(true),
      h.Style({
        height: "100%",
        inset: "0",
        overflow: "visible",
        "pointer-events": "none",
        position: "absolute",
        width: "100%",
      }),
    ],
    pipe(
      Array.appendAll(unlit, inLitChain),
      Array.map((curve) => edgeView(curve, lit, h)),
    ),
  );
};
