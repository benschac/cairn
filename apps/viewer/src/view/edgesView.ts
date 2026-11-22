import type { Trace } from "@cairn/contract";
import { Array, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { curvesOf, type Curve, type EdgeKind } from "../curves.ts";
import type { Positions } from "../geometry.ts";
import type { Message } from "../message.ts";
import { columnOf, stackLayoutOf } from "../stacks.ts";
import { isInChain, type Chain } from "../trace.ts";

const edgeColor = {
  dependency: "#b45309",
  implements: "#64748b",
  parent: "#334155",
  specifies: "#0f766e",
} satisfies Record.ReadonlyRecord<EdgeKind, string>;

/** One curve's path: highlighted with both ends in the active chain, dimmed otherwise. */
const edgeView = (
  curve: Curve,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html => {
  // None while no chain is active; otherwise whether both ends are in it.
  const maybeInChain = Option.map(
    maybeChain,
    (chain) => isInChain(chain, curve.source) && isInChain(chain, curve.target),
  );
  return h.path(
    Array.flatten([
      [h.DataAttribute("edge", curve.id), h.DataAttribute("kind", curve.kind)],
      Array.fromOption(
        Option.map(maybeInChain, (inChain) =>
          h.DataAttribute(inChain ? "highlighted" : "dimmed", "true"),
        ),
      ),
      [
        h.D(curve.path),
        h.Fill("none"),
        h.Stroke(edgeColor[curve.kind]),
        h.StrokeWidth(Option.contains(maybeInChain, true) ? "2.5" : "1.5"),
        h.Opacity(Option.contains(maybeInChain, false) ? "0.15" : "1"),
      ],
      curve.dashed ? [h.StrokeDasharray("6 4")] : [],
    ]),
  );
};

/**
 * One SVG path per curve between measured nodes. While a chain is active an edge with both ends
 * in it is highlighted and every other edge is dimmed.
 */
export const edgesView = (
  trace: Trace,
  positions: Positions,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html =>
  h.svg(
    [
      h.DataAttribute("edges", ""),
      h.Style({
        height: "100%",
        inset: "0",
        overflow: "visible",
        "pointer-events": "none",
        position: "absolute",
        width: "100%",
      }),
    ],
    Array.map(curvesOf(trace, positions, columnOf(stackLayoutOf(trace.tasks))), (curve) =>
      edgeView(curve, maybeChain, h),
    ),
  );
