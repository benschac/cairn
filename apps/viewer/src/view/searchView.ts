import { PrdSectionId, type Trace } from "@cairn/contract";
import type { Html } from "@effect/ui/html";
import { Array, Option, Record, Schema, String } from "effect";

import { SEARCH_INPUT_ID } from "../command.ts";
import { Message } from "../message.ts";
import { snippetOf, type FieldKind, type SearchResult, type SearchState } from "../search.ts";
import { Node, nodeKeyOf, nodeTitleOf } from "../trace.ts";
import { tagView, type TagKind } from "../ui/marks.ts";
import { markedView } from "./nodeView.ts";

const SEARCH_LISTBOX_ID = "search-results";

/** The option for a result, which the input names as its active descendant. */
const optionIdOf = (node: Node): string => `search-option-${nodeKeyOf(node)}`;

/** What each key does in the search input; every other key is left to the browser. */
const KEY_MESSAGES: Record.ReadonlyRecord<string, Message> = {
  ArrowDown: Message.PressedSearchArrowDown(),
  ArrowUp: Message.PressedSearchArrowUp(),
  Enter: Message.PressedSearchEnter(),
  Escape: Message.PressedSearchEscape(),
};

/** The Message for a key pressed in the search input; a handled key is also kept from the page. */
export const searchKeyMessage = (key: string): Option.Option<Message> =>
  Record.get(KEY_MESSAGES, key);

const FIELD_LABEL = {
  branch: "branch",
  id: "ID",
  prose: "text",
  title: "title",
} satisfies Record.ReadonlyRecord<FieldKind, string>;

const isPrdSection = Schema.is(PrdSectionId);

const kindOf = (node: Node): readonly [kind: TagKind, label: string] =>
  Node.match(node, {
    section: ({ id }) =>
      isPrdSection(id) ? (["prd", "PRD"] as const) : (["spec", "Spec"] as const),
    task: () => ["task", "Task"] as const,
  });

/** The context of a match: a bounded stretch of the text, marked, with an ellipsis where it is cut. */
const snippetView = (h: Html.H<Message>, result: SearchResult) => {
  const snippet = snippetOf(result);
  return Array.flatten([
    snippet.isCutBefore ? ["…"] : [],
    markedView(h, snippet.text, snippet.ranges),
    snippet.isCutAfter ? ["…"] : [],
  ]);
};

/** What the query matched, and the matched text itself unless it is the title the row already shows. */
const matchedFieldView = (h: Html.H<Message>, result: SearchResult) =>
  h.span
    .attr("data-search-field", result.field)
    .children(
      result.field === "title"
        ? FIELD_LABEL.title
        : Array.prepend(snippetView(h, result), `${FIELD_LABEL[result.field]}: `),
    );

const resultView = (h: Html.H<Message>, trace: Trace, result: SearchResult, isActive: boolean) => {
  const [kind, label] = kindOf(result.node);
  return (
    h.li
      .class("row")
      .id(optionIdOf(result.node))
      .attr("role", "option")
      .attr("aria-selected", `${isActive}`)
      .attr("data-search-result", nodeKeyOf(result.node))
      .attr("data-active", `${isActive}`)
      // The row's current mark, as the table of pieces has it.
      .attr("data-current", isActive ? "" : undefined)
      .on("click", Message.ClickedSearchResult({ node: result.node }))
      .children(
        h.span.attr("data-search-kind", "").children(tagView(h, kind, label)),
        h.span
          .attr("data-search-title", "")
          .children(
            result.field === "title"
              ? markedView(h, result.text, result.ranges)
              : nodeTitleOf(trace, result.node),
          ),
        h.div(matchedFieldView(h, result)),
      )
  );
};

const isActiveResult = (search: SearchState, result: SearchResult): boolean =>
  Option.exists(search.maybeActive, (active) => nodeKeyOf(active) === nodeKeyOf(result.node));

/** The count of results, or that there are none; nothing while the query is blank. */
const statusText = (search: SearchState): string =>
  Array.match(search.results, {
    onEmpty: () => (String.isEmpty(String.trim(search.query)) ? "" : "No results."),
    onNonEmpty: (results) =>
      Array.length(results) === 1 ? "1 result." : `${Array.length(results)} results.`,
  });

/**
 * The toolbar's search: a labelled combobox, a polite count that does not take focus, and the
 * ranked results as a listbox. The input handles the arrow keys, Enter and Escape itself, and
 * keeps a handled key from the page.
 */
export const searchView = (h: Html.H<Message>, trace: Trace, search: SearchState) => {
  const hasResults = Array.isReadonlyArrayNonEmpty(search.results);
  return h.div
    .class("search-box")
    .attr("data-search", "")
    .children(
      h.input
        .id(SEARCH_INPUT_ID)
        .attr("type", "text")
        .attr("role", "combobox")
        .attr("aria-label", "Search sections and tasks")
        .attr("placeholder", "Search sections and tasks")
        .attr("autocomplete", "off")
        .attr("aria-autocomplete", "list")
        .attr("aria-expanded", `${hasResults}`)
        .attr("aria-controls", hasResults ? SEARCH_LISTBOX_ID : undefined)
        .attr(
          "aria-activedescendant",
          Option.getOrUndefined(Option.map(search.maybeActive, optionIdOf)),
        )
        .value(search.query)
        .on("input", ({ value }) => Message.ChangedSearchQuery({ query: value }))
        .on("keydown", ({ key }) => Option.getOrUndefined(searchKeyMessage(key)), {
          preventDefault: true,
        }),
      h.p.attr("aria-live", "polite").attr("data-search-status", "").children(statusText(search)),
      hasResults &&
        h.ul
          .id(SEARCH_LISTBOX_ID)
          .attr("role", "listbox")
          .attr("aria-label", "Search results")
          .class("search-list")
          .children(
            Array.map(search.results, (result) =>
              resultView(h, trace, result, isActiveResult(search, result)),
            ),
          ),
    );
};
