// The Foldkit copy of a view that has moved to Effect UI, for the views still on Foldkit, which
// render under the bridge (`spec.viewer.effect-ui.views`). Delete it in the change that moves its
// last importer: `rg -l "foldkit/<this file>" apps/viewer/src`.

import { Array, Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import type { NodeSearch } from "../highlight.ts";
import type { Message } from "../message.ts";
import type { Rendered } from "../markdown.ts";
import { segmentsOf, type Range } from "../range.ts";
import type { FieldKind } from "../search.ts";

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

/** `data-searched`: "active" on the active result and "match" on any other node the query matched. */
export const searchedAttributesOf = (
  search: NodeSearch,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Attribute<Message>> =>
  search.isActive
    ? [h.DataAttribute("searched", "active")]
    : Option.isSome(search.maybeMatch)
      ? [h.DataAttribute("searched", "match")]
      : [];
