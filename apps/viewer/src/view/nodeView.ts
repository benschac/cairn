import type { SectionId, SectionStatus, Trace } from "@cairn/contract";
import { Array, Option, Record, String } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import {
  HOVER_FILL,
  PIN_PALETTE,
  SEARCH_FILL,
  chainsHolding,
  isPinned,
  pinColorsOf,
  type LitChain,
  type NodeSearch,
  type Pin,
} from "../highlight.ts";
import { Message } from "../message.ts";
import type { Rendered } from "../markdown.ts";
import { segmentsOf, withinOf, type Range } from "../range.ts";
import type { FieldKind } from "../search.ts";
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
      h.DataAttribute("stale", `${mark.stale}`),
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
      h.AriaPressed(`${isPinned(pins, node)}`),
      h.OnFocus(Message.HoveredNode({ node })),
      h.OnBlur(Message.LeftNode()),
      h.Style(PLAIN_BUTTON_STYLE),
    ],
    title,
  );

/** A node's CSS properties, by name. */
export type NodeStyle = Record.ReadonlyRecord<string, string>;

/** A matched stretch of text; its fill and underline come from the stylesheets. */
export const matchView = (text: string, h: HtmlBuilder<Message>): Html =>
  h.mark([h.DataAttribute("search-match", "")], [text]);

/** A field's text with each matched range in a `mark` element. */
export const markedView = (
  text: string,
  ranges: ReadonlyArray<Range>,
  h: HtmlBuilder<Message>,
): Rendered =>
  Array.map(segmentsOf(text, ranges), (segment) =>
    segment.isMatch ? matchView(segment.text, h) : segment.text,
  );

/** A rendered title, or its plain text with the matches marked when the query matched the title. */
export const titleView = (search: NodeSearch, title: Rendered, h: HtmlBuilder<Message>): Rendered =>
  Option.match(
    Option.filter(search.maybeMatch, (match) => match.field === "title"),
    {
      onNone: () => title,
      onSome: (match) => markedView(match.text, match.ranges, h),
    },
  );

/** The text of one of a node's searched fields: marked where the query matched that field, plain otherwise. */
export const fieldView = (
  search: NodeSearch,
  field: FieldKind,
  text: string,
  h: HtmlBuilder<Message>,
): Rendered =>
  Option.match(
    Option.filter(search.maybeMatch, (match) => match.field === field),
    {
      onNone: () => [text],
      onSome: (match) => markedView(match.text, match.ranges, h),
    },
  );

/**
 * A field's text from `start` on, such as a branch without its feature prefix, with the matches
 * in that part marked.
 */
export const fieldFromView = (
  search: NodeSearch,
  field: FieldKind,
  text: string,
  start: number,
  h: HtmlBuilder<Message>,
): Rendered =>
  Option.match(
    Option.filter(search.maybeMatch, (match) => match.field === field),
    {
      onNone: () => [String.slice(start)(text)],
      onSome: (match) =>
        markedView(
          String.slice(start)(match.text),
          withinOf(match.ranges, start, String.length(match.text)),
          h,
        ),
    },
  );

/** The outline of a node the query matched, and a stronger one for the active result. */
const searchStyleOf = (search: NodeSearch): NodeStyle =>
  search.isActive
    ? { outline: "3px solid #b45309", "outline-offset": "2px" }
    : Option.isSome(search.maybeMatch)
      ? { outline: "2px dashed #b45309", "outline-offset": "2px" }
      : {};

/** The fill of the top chain holding a node: a pin's colour, or a preview's. */
const fillOf = (top: LitChain): string =>
  Option.match(top.maybeColor, {
    onNone: () => (top.source === "search" ? SEARCH_FILL : HOVER_FILL),
    onSome: (color) => PIN_PALETTE[color].fill,
  });

/**
 * The fill of the top chain holding a node, and one stripe down its left edge per pin holding it,
 * so a node in several pinned flows shows each of their colours.
 */
const litStyleOf = (holding: Array.NonEmptyReadonlyArray<LitChain>): NodeStyle => {
  const top = Array.lastNonEmpty(holding);
  const fill = fillOf(top);
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

/**
 * The handlers every node carries, its style and, while any chain is lit, the attributes that
 * highlight a node in a lit chain or dim a node outside them all. Clicking anywhere on the node
 * pins or unpins it; its button's clicks reach the same handler.
 *
 * An element keeps only its last `h.Style`, so the node's own `style` comes in here and the
 * highlight is merged into it. A second `Style` would drop the node's own properties: a task
 * card would lose its grid cell, move out from under the pointer and flicker between hovered and
 * left.
 */
export const nodeAttributes = (
  lit: ReadonlyArray<LitChain>,
  node: Node,
  search: NodeSearch,
  h: HtmlBuilder<Message>,
  style: NodeStyle = {},
): ReadonlyArray<Attribute<Message>> => {
  const holding = chainsHolding(lit, node);
  const isLit = Array.isReadonlyArrayNonEmpty(lit);
  const litStyle: NodeStyle = Array.match(holding, {
    onEmpty: () => (isLit ? { opacity: DIMMED_OPACITY } : {}),
    onNonEmpty: litStyleOf,
  });
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
          searchStyleOf(search),
          (_own, outline) => outline,
        ),
      ),
    ],
    search.isActive
      ? [h.DataAttribute("searched", "active")]
      : Option.isSome(search.maybeMatch)
        ? [h.DataAttribute("searched", "match")]
        : [],
    isLit
      ? [h.DataAttribute(Array.isReadonlyArrayNonEmpty(holding) ? "highlighted" : "dimmed", "true")]
      : [],
    Array.match(pinColorsOf(holding), {
      onEmpty: () => [],
      onNonEmpty: (colors) => [h.DataAttribute("pins", Array.join(colors, " "))],
    }),
  ]);
};
