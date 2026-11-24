import { PrdSectionId, type Trace } from "@cairn/contract";
import { Array, Option, Record, Schema, String } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { SEARCH_INPUT_ID } from "../command.ts";
import { Message } from "../message.ts";
import { snippetOf, type FieldKind, type SearchResult, type SearchState } from "../search.ts";
import { Node, nodeKeyOf, nodeTitleOf } from "../trace.ts";
import type { Rendered } from "../markdown.ts";
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
const snippetView = (result: SearchResult, h: HtmlBuilder<Message>): Rendered => {
  const snippet = snippetOf(result);
  return Array.flatten([
    snippet.isCutBefore ? ["…"] : [],
    markedView(snippet.text, snippet.ranges, h),
    snippet.isCutAfter ? ["…"] : [],
  ]);
};

/** What the query matched, and the matched text itself unless it is the title the row already shows. */
const matchedFieldView = (result: SearchResult, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.DataAttribute("search-field", result.field)],
    result.field === "title"
      ? [FIELD_LABEL.title]
      : Array.prepend(snippetView(result, h), `${FIELD_LABEL[result.field]}: `),
  );

const resultView = (
  trace: Trace,
  result: SearchResult,
  isActive: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const [kind, label] = kindOf(result.node);
  return h.li(
    Array.appendAll(
      [
        h.Class("row"),
        h.Id(optionIdOf(result.node)),
        h.Role("option"),
        h.AriaSelected(isActive),
        h.DataAttribute("search-result", nodeKeyOf(result.node)),
        h.DataAttribute("active", `${isActive}`),
        h.OnClick(Message.ClickedSearchResult({ node: result.node })),
      ],
      // The row's current mark, as the table of pieces has it.
      isActive ? [h.DataAttribute("current", "")] : [],
    ),
    [
      h.span([h.DataAttribute("search-kind", "")], [tagView(kind, label, h)]),
      h.span(
        [h.DataAttribute("search-title", "")],
        result.field === "title"
          ? markedView(result.text, result.ranges, h)
          : [nodeTitleOf(trace, result.node)],
      ),
      h.div([], [matchedFieldView(result, h)]),
    ],
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
 * ranked results as a listbox. The input handles the arrow keys, Enter and Escape itself.
 */
export const searchView = (trace: Trace, search: SearchState, h: HtmlBuilder<Message>): Html => {
  const hasResults = Array.isReadonlyArrayNonEmpty(search.results);
  const input = h.input(
    Array.flatten([
      [
        h.Id(SEARCH_INPUT_ID),
        h.Type("text"),
        h.Role("combobox"),
        h.AriaLabel("Search sections and tasks"),
        h.Placeholder("Search sections and tasks"),
        h.Autocomplete("off"),
        h.AriaAutocomplete("list"),
        h.AriaExpanded(hasResults),
        h.Value(search.query),
        h.OnInput((query) => Message.ChangedSearchQuery({ query })),
        h.OnKeyDownPreventDefault(searchKeyMessage),
      ],
      hasResults ? [h.AriaControls(SEARCH_LISTBOX_ID)] : [],
      Array.fromOption(
        Option.map(search.maybeActive, (node) => h.AriaActiveDescendant(optionIdOf(node))),
      ),
    ]),
  );
  const status = h.p(
    [h.AriaLive("polite"), h.DataAttribute("search-status", "")],
    [statusText(search)],
  );
  const list = h.ul(
    [
      h.Id(SEARCH_LISTBOX_ID),
      h.Role("listbox"),
      h.AriaLabel("Search results"),
      h.Class("search-list"),
    ],
    Array.map(search.results, (result) =>
      resultView(trace, result, isActiveResult(search, result), h),
    ),
  );
  return h.div(
    [h.Class("search-box"), h.DataAttribute("search", "")],
    hasResults ? [input, status, list] : [input, status],
  );
};
