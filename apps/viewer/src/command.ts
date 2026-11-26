import { Command } from "@effect/ui";
import { Effect, Schema } from "effect";

import { focusElement, scrollElementIntoView } from "./dom.ts";
import { Message } from "./message.ts";
import { fetchPatch, fetchSession } from "./load.ts";
import { Node, nodeKeyOf } from "./trace.ts";
import { turnElementIdOf } from "./view/sessionView.ts";

/** The id of the search input, which a click on a result returns focus to. */
export const SEARCH_INPUT_ID = "search-input";

/** Moves focus back to the search input, which a click on one of its results took it from. */
export const FocusSearchInput = Command.make("FocusSearchInput", { args: {} }, () =>
  focusElement(`#${SEARCH_INPUT_ID}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusSearchInput()),
  ),
);

/** A node's option in the search list. */
export const searchResultSelector = (node: Node): string =>
  `[data-search-result="${nodeKeyOf(node)}"]`;

/** Scrolls the search list so the active result shows; focus stays in the input. */
export const ScrollSearchResult = Command.make(
  "ScrollSearchResult",
  { args: { node: Node } },
  ({ node }) =>
    scrollElementIntoView(searchResultSelector(node)).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollSearchResult()),
    ),
);

/** Fetches a patch route's text and reports it, or why it could not be had. */
export const FetchPatch = Command.make(
  "FetchPatch",
  { args: { path: Schema.String } },
  ({ path }) =>
    fetchPatch(path).pipe(
      Effect.result,
      Effect.map((result) => Message.ReceivedPatch({ path, result })),
    ),
);

/** Scrolls the session pane so a turn's element shows; a turn that is not in the page is left alone. */
export const ScrollTurn = Command.make("ScrollTurn", { args: { id: Schema.String } }, ({ id }) =>
  scrollElementIntoView(`[id="${turnElementIdOf(id)}"]`, "nearest").pipe(
    Effect.ignore,
    Effect.as(Message.CompletedScrollTurn()),
  ),
);

/** Fetches a session by ID and reports it, or why it could not be had. */
export const FetchSession = Command.make(
  "FetchSession",
  { args: { id: Schema.String } },
  ({ id }) =>
    fetchSession(id).pipe(
      Effect.result,
      Effect.map((result) => Message.ReceivedSession({ id, result })),
    ),
);
