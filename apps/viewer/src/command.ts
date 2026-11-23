import { Effect } from "effect";
import { Command, Dom } from "foldkit";

import { DRAWER_HEADING_ID } from "./drawer.ts";
import { Message } from "./message.ts";
import { Node, nodeKeyOf } from "./trace.ts";

/** A node's button on the canvas, which focus returns to when its drawer closes. */
export const nodeButtonSelector = (node: Node): string => `[data-node-button="${nodeKeyOf(node)}"]`;

/** The id of the search input, which a click on a result returns focus to. */
export const SEARCH_INPUT_ID = "search-input";

/** Moves focus back to the search input, which a click on one of its results took it from. */
export const FocusSearchInput = Command.define("FocusSearchInput", {
  messages: [Message.CompletedFocusSearchInput],
  execute: Dom.focus(`#${SEARCH_INPUT_ID}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusSearchInput()),
  ),
});

/** A node's option in the search list. */
export const searchResultSelector = (node: Node): string =>
  `[data-search-result="${nodeKeyOf(node)}"]`;

/** Scrolls the search list so the active result shows; focus stays in the input. */
export const ScrollSearchResult = Command.define("ScrollSearchResult", {
  args: { node: Node },
  messages: [Message.CompletedScrollSearchResult],
  execute: ({ node }) =>
    Dom.scrollIntoView(searchResultSelector(node)).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollSearchResult()),
    ),
});

/** Moves focus to the heading of the drawer that just opened. */
export const FocusDrawerHeading = Command.define("FocusDrawerHeading", {
  messages: [Message.CompletedFocusDrawerHeading],
  execute: Dom.focus(`#${DRAWER_HEADING_ID}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusDrawerHeading()),
  ),
});

/** Moves focus back to the button of the node whose drawer just closed. */
export const FocusNode = Command.define("FocusNode", {
  args: { node: Node },
  messages: [Message.CompletedFocusNode],
  execute: ({ node }) =>
    Dom.focus(nodeButtonSelector(node)).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedFocusNode()),
    ),
});
