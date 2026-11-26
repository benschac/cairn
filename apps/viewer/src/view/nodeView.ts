import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Array, Option } from "effect";

import type { Attributable } from "../effect-ui/attributes.ts";
import type { NodeSearch } from "../highlight.ts";
import type { Message } from "../message.ts";
import { segmentsOf, type Range } from "../range.ts";
import type { FieldKind } from "../search.ts";

/** A matched stretch of text; its fill and underline come from the stylesheets. */
export const matchView = (h: Html.H<Message>, text: string) =>
  h.mark.attr("data-search-match", "").children(text);

/** A field's text with each matched range in a `mark` element. */
export const markedView = (h: Html.H<Message>, text: string, ranges: ReadonlyArray<Range>) =>
  Array.map(segmentsOf(text, ranges), (segment) =>
    segment.isMatch ? matchView(h, segment.text) : segment.text,
  );

/** A rendered title, or its plain text with the matches marked when the query matched the title. */
export const titleView = (
  h: Html.H<Message>,
  search: NodeSearch,
  title: View.Input<Message>,
): View.Input<Message> =>
  Option.match(
    Option.filter(search.maybeMatch, (match) => match.field === "title"),
    {
      onNone: () => title,
      onSome: (match) => markedView(h, match.text, match.ranges),
    },
  );

/** The text of one of a node's searched fields: marked where the query matched that field, plain otherwise. */
export const fieldView = (
  h: Html.H<Message>,
  search: NodeSearch,
  field: FieldKind,
  text: string,
): View.Input<Message> =>
  Option.match(
    Option.filter(search.maybeMatch, (match) => match.field === field),
    {
      onNone: () => text,
      onSome: (match) => markedView(h, match.text, match.ranges),
    },
  );

/**
 * `data-searched`, on the builder it is given: "active" on the active result and "match" on any
 * other node the query matched.
 */
export const withSearched = <B>(builder: B & Attributable<B>, search: NodeSearch): B =>
  builder.attrs({
    "data-searched": search.isActive
      ? "active"
      : Option.isSome(search.maybeMatch)
        ? "match"
        : undefined,
  });
