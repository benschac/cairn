import type { SectionId, SectionStatus, Trace } from "@cairn/contract";
import { Array, Option, Record } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import {
  HOVER_FILL,
  PIN_PALETTE,
  SEARCH_FILL,
  chainsHolding,
  isPinned,
  pinColorsOf,
  searchRoleOf,
  type LitChain,
  type Pin,
  type SearchRole,
} from "../highlight.ts";
import { Message } from "../message.ts";
import type { Rendered } from "../markdown.ts";
import {
  segmentsOf,
  type FieldKind,
  type Range,
  type Search,
  type SearchResult,
} from "../search.ts";
import {
  judgmentMarkOf,
  nodeKeyOf,
  sectionStatusOf,
  type JudgmentMark,
  type Node,
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

/** The highlighter's yellow behind the characters a query matched. */
const MARK_STYLE = { background: "#fde047", color: "#1c1917", "border-radius": "2px" };

/** Text with the characters a query matched in `mark` elements, which carry no other change. */
export const markedTextView = (
  text: string,
  ranges: ReadonlyArray<Range>,
  h: HtmlBuilder<Message>,
): Rendered =>
  Array.map(segmentsOf(text, ranges), (segment) =>
    segment.isMatch
      ? h.mark([h.DataAttribute("search-match", ""), h.Style(MARK_STYLE)], [segment.text])
      : segment.text,
  );

/**
 * A node's text for one field. When the node's search result matched exactly this text of this
 * field its characters are marked; any other text is shown as it is.
 */
export const fieldTextView = (
  maybeResult: Option.Option<SearchResult>,
  field: FieldKind,
  text: string,
  h: HtmlBuilder<Message>,
): Rendered =>
  Option.match(
    Option.filter(maybeResult, (result) => result.field === field && result.text === text),
    { onNone: () => [text], onSome: (result) => markedTextView(text, result.ranges, h) },
  );

const DIMMED_OPACITY = "0.35";

/** Pixels of each pin's stripe down a node's left edge. */
const STRIPE_WIDTH = 4;

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
 * The button that holds a node's title, for the keyboard and for assistive technology: a click on
 * it reaches the node's own click handler, which pins or unpins the node. Focusing it previews the
 * chain as hovering does. It is pressed while the node is pinned, so a pin is not shown by colour
 * alone.
 */
export const nodeButtonView = (
  node: Node,
  pins: ReadonlyArray<Pin>,
  title: Rendered,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("nopan"),
      h.DataAttribute("node-button", nodeKeyOf(node)),
      h.AriaPressed(String(isPinned(pins, node))),
      h.OnFocus(Message.HoveredNode({ node })),
      h.OnBlur(Message.LeftNode()),
      h.Style(PLAIN_BUTTON_STYLE),
    ],
    title,
  );

/** A node's CSS properties, by name. */
export type NodeStyle = Record.ReadonlyRecord<string, string>;

/**
 * The fill of the top chain holding a node, and one stripe down its left edge per pin holding it,
 * so a node in several pinned flows shows each of their colours.
 */
const litStyleOf = (holding: Array.NonEmptyReadonlyArray<LitChain>): NodeStyle => {
  const top = Array.lastNonEmpty(holding);
  const fill = Option.match(top.maybeColor, {
    onNone: () => (top.source === "search" ? SEARCH_FILL : HOVER_FILL),
    onSome: (color) => PIN_PALETTE[color].fill,
  });
  return Array.match(pinColorsOf(holding), {
    onEmpty: () => ({ background: fill }),
    onNonEmpty: (colors) => ({
      background: fill,
      "box-shadow": Array.join(
        Array.map(
          colors,
          (color, index) =>
            `inset ${(index + 1) * STRIPE_WIDTH}px 0 0 ${PIN_PALETTE[color].stroke}`,
        ),
        ", ",
      ),
    }),
  });
};

/** How each search role outlines a node, so the active result is never told by colour alone. */
const SEARCH_OUTLINE: Record.ReadonlyRecord<SearchRole, NodeStyle> = {
  active: { outline: "3px solid #1c1917", "outline-offset": "2px" },
  match: { outline: "2px dashed #57534e", "outline-offset": "2px" },
  none: {},
};

/**
 * The handlers every node carries, its style and, while any chain is lit, the attributes that
 * highlight a node in a lit chain or dim a node outside them all. Clicking anywhere on the node
 * pins or unpins it; its button's clicks reach the same handler.
 *
 * A node the search matched directly also carries an outline and `data-search`, "active" for the
 * active result and "match" for the rest, and is never dimmed: its marks have to stay readable. A
 * node that is only in the active result's chain is highlighted like any chain member and carries
 * `data-search-chain`, with no outline.
 *
 * An element keeps only its last `h.Style`, so the node's own `style` comes in here and the
 * highlight is merged into it. A second `Style` would drop the node's own properties: a task
 * card would lose its grid cell, move out from under the pointer and flicker between hovered and
 * left.
 */
export const nodeAttributes = (
  lit: ReadonlyArray<LitChain>,
  search: Search,
  node: Node,
  h: HtmlBuilder<Message>,
  style: NodeStyle = {},
): ReadonlyArray<Attribute<Message>> => {
  const holding = chainsHolding(lit, node);
  const isLit = Array.isReadonlyArrayNonEmpty(lit);
  const role = searchRoleOf(search, node);
  const litStyle: NodeStyle = Array.match(holding, {
    onEmpty: () => (isLit && role === "none" ? { opacity: DIMMED_OPACITY } : {}),
    onNonEmpty: litStyleOf,
  });
  const isInSearchChain = Array.some(holding, ({ source }) => source === "search");
  return Array.flatten([
    [
      // `nopan`: a drag that starts on a node selects its text instead of panning the canvas.
      h.Class("nopan"),
      h.OnClick(Message.ClickedNode({ node })),
      h.OnMouseEnter(Message.HoveredNode({ node })),
      h.OnMouseLeave(Message.LeftNode()),
      h.Style(
        Record.union(
          Record.union(style, litStyle, (_own, highlight) => highlight),
          SEARCH_OUTLINE[role],
          (_own, outline) => outline,
        ),
      ),
    ],
    isLit && (Array.isReadonlyArrayNonEmpty(holding) || role === "none")
      ? [h.DataAttribute(Array.isReadonlyArrayNonEmpty(holding) ? "highlighted" : "dimmed", "true")]
      : [],
    role === "none" ? [] : [h.DataAttribute("search", role)],
    isInSearchChain ? [h.DataAttribute("search-chain", "true")] : [],
    Array.match(pinColorsOf(holding), {
      onEmpty: () => [],
      onNonEmpty: (colors) => [h.DataAttribute("pins", Array.join(colors, " "))],
    }),
  ]);
};
