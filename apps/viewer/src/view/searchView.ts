import type { Trace } from "@cairn/contract";
import { Array, Match, Option, String } from "effect";
import type { Html, HtmlBuilder, KeyboardModifiers } from "foldkit/html";

import { Message } from "../message.ts";
import {
  SEARCH_INPUT_ID,
  SEARCH_LISTBOX_ID,
  searchOptionIdOf,
  type Search,
  type SearchResult,
} from "../search.ts";
import { Node, nodeKeyOf, sectionTitleOf } from "../trace.ts";
import { markedTextView } from "./nodeView.ts";

/** The message a key sends from the search input; none for a key the browser keeps for typing. */
export const searchKeyMessageOf = (
  key: string,
  modifiers: KeyboardModifiers,
): Option.Option<Message> =>
  modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey
    ? Option.none()
    : Match.value(key).pipe(
        Match.withReturnType<Option.Option<Message>>(),
        Match.when("ArrowDown", () => Option.some(Message.PressedSearchArrowDown())),
        Match.when("ArrowUp", () => Option.some(Message.PressedSearchArrowUp())),
        Match.when("Enter", () => Option.some(Message.PressedSearchEnter())),
        Match.when("Escape", () => Option.some(Message.PressedSearchEscape())),
        Match.orElse(() => Option.none()),
      );

/** What a query that found something or nothing says, for the people who cannot see the list. */
export const searchStatusOf = (search: Search): string => {
  const query = String.trim(search.query);
  return String.isEmpty(query)
    ? ""
    : Array.match(search.results, {
        onEmpty: () => `No results for "${query}"`,
        onNonEmpty: (results) =>
          Array.length(results) === 1 ? "1 result" : `${Array.length(results)} results`,
      });
};

/** A node's own title: a section's heading text, or a task's title. */
const titleOf = (trace: Trace, node: Node): string =>
  Node.match(node, {
    section: ({ id }) => sectionTitleOf(trace, id),
    task: ({ id }) =>
      Option.getOrElse(
        Option.map(
          Array.findFirst(trace.tasks, (task) => task.id === id),
          (task) => task.title,
        ),
        () => id,
      ),
  });

/** Which kind of node a result is: a PRD or spec section, or a task. */
const kindOf = (trace: Trace, node: Node): string =>
  Node.match(node, {
    section: ({ id }) =>
      Array.some(trace.prd.sections, (section) => section.id === id) ? "PRD" : "Spec",
    task: () => "Task",
  });

const resultView = (
  trace: Trace,
  search: Search,
  result: SearchResult,
  h: HtmlBuilder<Message>,
): Html => {
  const isActive = Option.exists(
    search.maybeActive,
    (active) => nodeKeyOf(active) === nodeKeyOf(result.node),
  );
  return h.li(
    [
      h.Id(searchOptionIdOf(result.node)),
      h.Role("option"),
      h.AriaSelected(isActive),
      h.DataAttribute("search-result", result.node.id),
      h.DataAttribute("active", `${isActive}`),
      h.OnClick(Message.ClickedSearchResult({ node: result.node })),
      h.Style({
        background: isActive ? "#e7e5e4" : "transparent",
        cursor: "pointer",
        // The active result is told by its outline as well as its fill.
        outline: isActive ? "2px solid #1c1917" : "none",
        "outline-offset": "-2px",
        padding: "2px 4px",
      }),
    ],
    [
      h.span(
        [h.DataAttribute("kind", ""), h.Style({ "font-size": "11px", opacity: "0.7" })],
        [kindOf(trace, result.node)],
      ),
      " ",
      h.span(
        [h.DataAttribute("title", "")],
        result.field === "title"
          ? markedTextView(result.text, result.ranges, h)
          : [titleOf(trace, result.node)],
      ),
      " ",
      h.small(
        [h.DataAttribute("matched-field", result.field), h.Style({ opacity: "0.7" })],
        result.field === "title"
          ? ["title"]
          : Array.prepend(
              markedTextView(result.snippet.text, result.snippet.ranges, h),
              `${result.field}: `,
            ),
      ),
    ],
  );
};

/**
 * The toolbar's search: a labelled input that is a combobox over a listbox of ranked results, and a
 * live count that announces what a query found without taking focus. Only this input handles the
 * arrow, Enter and Escape keys, so none of them reaches the canvas.
 */
export const searchView = (trace: Trace, search: Search, h: HtmlBuilder<Message>): Html => {
  const hasResults = Array.isReadonlyArrayNonEmpty(search.results);
  return h.div(
    [h.DataAttribute("search-control", ""), h.Style({ margin: "0 0 8px" })],
    [
      h.label(
        [h.For(SEARCH_INPUT_ID), h.Style({ display: "block", "font-size": "12px" })],
        ["Search"],
      ),
      h.input(
        Array.appendAll(
          [
            h.Id(SEARCH_INPUT_ID),
            h.Type("search"),
            h.Role("combobox"),
            h.Autocomplete("off"),
            h.Placeholder("Sections, tasks, branches"),
            h.Value(search.query),
            h.AriaExpanded(hasResults),
            h.AriaControls(SEARCH_LISTBOX_ID),
            h.AriaAutocomplete("list"),
            h.OnInput((query) => Message.EditedSearchQuery({ query })),
            h.OnKeyDownPreventDefault(searchKeyMessageOf),
            h.Style({ "box-sizing": "border-box", width: "100%" }),
          ],
          Array.map(Array.fromOption(search.maybeActive), (active) =>
            h.AriaActiveDescendant(searchOptionIdOf(active)),
          ),
        ),
      ),
      // The count is read out as it changes; the live region never takes focus.
      h.p(
        [
          h.DataAttribute("search-status", ""),
          h.AriaLive("polite"),
          h.AriaAtomic(true),
          h.Style({ "font-size": "12px", margin: "4px 0 0" }),
        ],
        [searchStatusOf(search)],
      ),
      h.ul(
        [
          h.Id(SEARCH_LISTBOX_ID),
          h.Role("listbox"),
          h.AriaLabel("Search results"),
          h.Hidden(!hasResults),
          h.Style({
            display: hasResults ? "block" : "none",
            "font-size": "13px",
            "list-style": "none",
            margin: "4px 0 0",
            "max-height": "240px",
            "overflow-y": "auto",
            padding: "0",
          }),
        ],
        Array.map(search.results, (result) => resultView(trace, search, result, h)),
      ),
    ],
  );
};
