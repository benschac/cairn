import type { SectionId, SectionStatus, Trace } from "@cairn/contract";
import { Array, Option, Record, Schema } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../message.ts";
import type { Rendered } from "../markdown.ts";
import {
  Node,
  isInChain,
  judgmentMarkOf,
  nodeKeyOf,
  sectionStatusOf,
  type Chain,
  type JudgmentMark,
} from "../trace.ts";

// NOTE: the node buttons are native buttons with Type("button"). @foldkit/ui's Button.view adds
// only Tabindex(0) over that, so it is not a dependency.

export const badgeView = (status: SectionStatus, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute("badge", ""),
      h.DataAttribute("status", status),
      h.Style({ "font-size": "11px", "margin-left": "8px", opacity: "0.8" }),
    ],
    [status],
  );

export const judgmentMarkView = (mark: JudgmentMark, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute("judgment", mark.verdict),
      h.DataAttribute("stale", String(mark.stale)),
      h.Style({ "font-size": "11px", "margin-left": "8px", opacity: mark.stale ? "0.4" : "1" }),
    ],
    [mark.stale ? `${mark.verdict} (stale)` : mark.verdict],
  );

/** The badge for a section's rollup status; nothing when the trace has none for it. */
export const sectionBadgeViews = (
  trace: Trace,
  id: SectionId,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.fromOption(Option.map(sectionStatusOf(trace, id), (status) => badgeView(status, h)));

/** The marker for a node's worst judgment; nothing when it has none. */
export const judgmentMarkViews = (
  trace: Trace,
  node: Node,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.fromOption(Option.map(judgmentMarkOf(trace, node), (mark) => judgmentMarkView(mark, h)));

const HIGHLIGHTED_BACKGROUND = "#fef08a";
const DIMMED_OPACITY = "0.35";

const nodeEquivalence = Schema.toEquivalence(Node);

/** A button looks like the text it holds. */
const PLAIN_BUTTON_STYLE = {
  background: "none",
  border: "none",
  color: "inherit",
  cursor: "pointer",
  font: "inherit",
  padding: "0",
  "text-align": "inherit",
};

/**
 * The button that holds a node's title: clicking it toggles the node's drawer, and focusing it
 * previews the chain as hovering does. It is pressed while the node's drawer is open, so the
 * selection is not shown by colour alone.
 */
export const nodeButtonView = (
  node: Node,
  maybeSelected: Option.Option<Node>,
  title: Rendered,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("nopan"),
      h.DataAttribute("node-button", nodeKeyOf(node)),
      h.AriaPressed(
        String(Option.exists(maybeSelected, (selected) => nodeEquivalence(selected, node))),
      ),
      h.OnClick(Message.ClickedNode({ node })),
      h.OnFocus(Message.HoveredNode({ node })),
      h.OnBlur(Message.LeftNode()),
      h.Style(PLAIN_BUTTON_STYLE),
    ],
    title,
  );

/** A node's CSS properties, by name. */
export type NodeStyle = Record.ReadonlyRecord<string, string>;

/**
 * The hover handlers every node carries, its style and, while a chain is active, the attributes
 * that highlight a node in it or dim a node outside it. Its button carries the click.
 *
 * An element keeps only its last `h.Style`, so the node's own `style` comes in here and the
 * highlight is merged into it. A second `Style` would drop the node's own properties: a task
 * card would lose its grid cell, move out from under the pointer and flicker between hovered and
 * left.
 */
export const nodeAttributes = (
  maybeChain: Option.Option<Chain>,
  node: Node,
  h: HtmlBuilder<Message>,
  style: NodeStyle = {},
): ReadonlyArray<Attribute<Message>> => {
  const maybeInChain = Option.map(maybeChain, (chain) => isInChain(chain, node));
  const chainStyle: NodeStyle = Option.match(maybeInChain, {
    onNone: () => ({}),
    onSome: (inChain) =>
      inChain ? { background: HIGHLIGHTED_BACKGROUND } : { opacity: DIMMED_OPACITY },
  });
  return Array.appendAll(
    [
      // `nopan`: a drag that starts on a node selects its text instead of panning the canvas.
      h.Class("nopan"),
      h.OnMouseEnter(Message.HoveredNode({ node })),
      h.OnMouseLeave(Message.LeftNode()),
      h.Style(Record.union(style, chainStyle, (_own, chain) => chain)),
    ],
    Array.fromOption(
      Option.map(maybeInChain, (inChain) =>
        h.DataAttribute(inChain ? "highlighted" : "dimmed", "true"),
      ),
    ),
  );
};
