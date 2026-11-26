import { Array, Option, String } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Arrow } from "../arrows.ts";
import type { Message } from "../message.ts";
import { isKeyInChain } from "../wires.ts";
import type { Chain } from "../trace.ts";

const HEAD_ID = "arrow-head";

/** The key of the chip an arrow ends at: a fork's label stands for its child. */
const childKeyOf = (target: string): string =>
  String.startsWith("fork:")(target) ? `task:${String.slice("fork:".length)(target)}` : target;

const headView = (h: HtmlBuilder<Message>): Html =>
  h.defs(
    [],
    [
      h.marker(
        [
          h.Id(HEAD_ID),
          h.ViewBox("0 0 8 8"),
          h.RefX("7"),
          h.RefY("4"),
          h.MarkerWidth("7"),
          h.MarkerHeight("7"),
          h.MarkerUnits("userSpaceOnUse"),
          h.Orient("auto"),
        ],
        [h.polygon([h.Points("0,0.5 8,4 0,7.5"), h.Fill("var(--ink)")])],
      ),
    ],
  );

const arrowView = (
  arrow: Arrow,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html => {
  const isDimmed = Option.exists(
    maybeChain,
    (chain) => !isKeyInChain(chain, childKeyOf(arrow.target)),
  );
  return h.path(
    Array.flatten([
      [
        h.DataAttribute("arrow", arrow.kind),
        h.DataAttribute("arrow-source", arrow.source),
        h.DataAttribute("arrow-target", arrow.target),
        h.D(arrow.path),
        h.Fill("none"),
        h.MarkerEnd(`url(#${HEAD_ID})`),
        h.Style({
          opacity: isDimmed ? "0.15" : "0.55",
          stroke: "var(--ink)",
          "stroke-width": "1.4",
          transition: "opacity var(--d-fade) ease-out",
        }),
      ],
      isDimmed ? [h.DataAttribute("dimmed", "")] : [],
    ]),
  );
};

/**
 * One SVG over the stacks list, the list's size and out of the pointer's way, under the chips:
 * a path for each arrow, dimmed with its child's chip while another chain is hovered.
 */
export const arrowsView = (
  arrows: ReadonlyArray<Arrow>,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html =>
  h.svg(
    [
      h.DataAttribute("arrow-layer", ""),
      h.AriaHidden(true),
      h.Style({
        height: "100%",
        inset: "0",
        overflow: "visible",
        "pointer-events": "none",
        position: "absolute",
        width: "100%",
        "z-index": "0",
      }),
    ],
    Array.prepend(
      Array.map(arrows, (arrow) => arrowView(arrow, maybeChain, h)),
      headView(h),
    ),
  );
