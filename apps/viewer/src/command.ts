import { Effect, Schema } from "effect";
import { Command, Dom } from "foldkit";

import { DRAWER_HEADING_ID } from "./drawer.ts";
import { Message } from "./message.ts";
import { fetchPatch } from "./load.ts";
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

/** Fetches a patch route's text and reports it, or why it could not be had. */
export const FetchPatch = Command.define("FetchPatch", {
  args: { path: Schema.String },
  messages: [Message.ReceivedPatch],
  execute: ({ path }) =>
    fetchPatch(path).pipe(
      Effect.result,
      Effect.map((result) => Message.ReceivedPatch({ path, result })),
    ),
});
