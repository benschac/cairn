import { LinkFromPath, decodeLink, type Link, type LinkError } from "@cairn/contract";
import { Effect, Schema, type Option, type Result } from "effect";
import { Command, Navigation, type Url } from "foldkit";

import { Message } from "./message.ts";

/**
 * The viewer's only route. Foldkit's route combinators read a fixed shape of segments, and a link
 * is a list of steps of any length, so the route is the whole path run through `LinkFromPath`,
 * which stays the one definition of a link. A path that is not a link gives its `LinkError`, which
 * the notice shows. A list of steps that breaks the ordering rules has no path.
 */
export const linkRoute = {
  parse: (url: Url.Url): Result.Result<Link, LinkError> => decodeLink(url.pathname),
  print: (link: Link): Option.Option<string> => Schema.encodeOption(LinkFromPath)(link),
};

/**
 * Adds an entry to the browser history with a link's path. It does not send Foldkit's URL change
 * event: the model is what the address shows, so the viewer's own writes are not read back, and
 * the entries written one per step for a link opened in a new window are not each opened again.
 */
export const PushUrl = Command.define("PushUrl", {
  args: { path: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ path }) =>
    Effect.sync(() => window.history.pushState(null, "", path)).pipe(
      Effect.as(Message.CompletedNavigation()),
    ),
});

/** Replaces the current history entry's address with a link's path, as `PushUrl` writes one. */
export const ReplaceUrl = Command.define("ReplaceUrl", {
  args: { path: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ path }) =>
    Effect.sync(() => window.history.replaceState(null, "", path)).pipe(
      Effect.as(Message.CompletedNavigation()),
    ),
});

/**
 * Goes to an anchor's address the way the browser would without routing: a session route, a file
 * a document links to, another site, or a fragment of this page.
 */
export const LoadUrl = Command.define("LoadUrl", {
  args: { href: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ href }) => Navigation.load(href).pipe(Effect.as(Message.CompletedNavigation())),
});
