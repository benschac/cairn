import { Array, HashSet, Match, Option, String } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Arrow } from "../arrows.ts";
import type { Message } from "../message.ts";
import { isKeyInChain } from "../wires.ts";
import type { Chain } from "../trace.ts";

const HEAD_ID = "arrow-head";

/** The key of the chip an arrow ends at: a fork's label stands for its child. */
const childKeyOf = (target: string): string =>
  String.startsWith("fork:")(target) ? `task:${String.slice("fork:".length)(target)}` : target;

/** The task a `task:<id>` or `fork:<id>` key names. */
const idOf = (key: string): string => Array.lastNonEmpty(String.split(":")(key));

/** How each kind is drawn: a parent arrow is solid and faint, a dependency arrow dashed and full. */
const lineOf = (kind: Arrow["kind"]) =>
  Match.value(kind).pipe(
    Match.when("parent", () => ({ dash: "none", opacity: "0.55", width: "1.4" })),
    Match.when("dependency", () => ({ dash: "4 3", opacity: "1", width: "1.6" })),
    Match.exhaustive,
  );

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
  lit: HashSet.HashSet<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const line = lineOf(arrow.kind);
  // A parent arrow is dimmed with its child's chip, which is not dimmed while it is lit. A
  // dependency arrow is the one drawn for the task in focus, so it never is.
  const isDimmed =
    arrow.kind === "parent" &&
    Option.exists(
      maybeChain,
      (chain) =>
        !isKeyInChain(chain, childKeyOf(arrow.target)) && !HashSet.has(lit, idOf(arrow.target)),
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
          opacity: isDimmed ? "0.15" : line.opacity,
          stroke: "var(--ink)",
          "stroke-dasharray": line.dash,
          "stroke-width": line.width,
          transition: "opacity var(--d-fade) ease-out",
        }),
      ],
      isDimmed ? [h.DataAttribute("dimmed", "")] : [],
    ]),
  );
};

/**
 * One SVG over the stacks list, the list's size and out of the pointer's way, under the chips:
 * a path for each arrow in order, so the dependency arrows are over the parent ones. A parent arrow
 * is dimmed with its child's chip while another chain is hovered, unless the chip is in `lit`.
 */
export const arrowsView = (
  arrows: ReadonlyArray<Arrow>,
  maybeChain: Option.Option<Chain>,
  lit: HashSet.HashSet<string>,
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
      Array.map(arrows, (arrow) => arrowView(arrow, maybeChain, lit, h)),
      headView(h),
    ),
  );
