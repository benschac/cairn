import type { SectionStatus } from "@cairn/contract";
import { Array, Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../message.ts";
import { isInChain, type Chain, type JudgmentMark, type Node } from "../trace.ts";

export const badgeView = (status: SectionStatus, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute("badge", ""),
      h.DataAttribute("status", status),
      h.Style({ "font-size": "11px", "margin-left": "8px", opacity: "0.8" }),
    ],
    [status],
  );

export const judgmentView = (mark: JudgmentMark, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute("judgment", mark.verdict),
      h.DataAttribute("stale", String(mark.stale)),
      h.Style({ "font-size": "11px", "margin-left": "8px", opacity: mark.stale ? "0.4" : "1" }),
    ],
    [mark.verdict],
  );

const highlightedBackground = "#fef08a";
const dimmedOpacity = "0.35";

/**
 * The hover and click handlers every node carries and, while a chain is active, the
 * attributes that highlight a node in it or dim a node outside it.
 */
export const nodeAttributes = (
  maybeChain: Option.Option<Chain>,
  node: Node,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Attribute<Message>> =>
  Array.appendAll(
    [
      // `nopan`: a drag that starts on a node selects its text instead of panning the canvas.
      h.Class("nopan"),
      h.OnMouseEnter(Message.HoveredNode({ node })),
      h.OnMouseLeave(Message.LeftNode()),
      h.OnClick(Message.ClickedNode({ node })),
    ],
    Option.match(maybeChain, {
      onNone: () => [],
      onSome: (chain) =>
        isInChain(chain, node)
          ? [h.DataAttribute("highlighted", "true"), h.Style({ background: highlightedBackground })]
          : [h.DataAttribute("dimmed", "true"), h.Style({ opacity: dimmedOpacity })],
    }),
  );
