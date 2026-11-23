import { Effect } from "effect";
import { Command, Dom } from "foldkit";

import { DRAWER_HEADING_ID } from "./drawer.ts";
import { Message } from "./message.ts";
import { SEARCH_INPUT_ID, searchOptionIdOf } from "./search.ts";
import { Node, nodeKeyOf } from "./trace.ts";

/** A node's button on the canvas, which focus returns to when its drawer closes. */
export const nodeButtonSelector = (node: Node): string => `[data-node-button="${nodeKeyOf(node)}"]`;

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

/** Scrolls the active search result into view in the result list, which keeps its own scroll. */
export const ScrollSearchResult = Command.define("ScrollSearchResult", {
  args: { node: Node },
  messages: [Message.CompletedScrollSearchResult],
  execute: ({ node }) =>
    Dom.scrollIntoViewAfterPaint(`[id="${searchOptionIdOf(node)}"]`, { block: "nearest" }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollSearchResult()),
    ),
});

/** Moves focus back to the search input after a click on a result took it, so the keys keep working. */
export const FocusSearch = Command.define("FocusSearch", {
  messages: [Message.CompletedFocusSearch],
  execute: Dom.focus(`#${SEARCH_INPUT_ID}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusSearch()),
  ),
});
