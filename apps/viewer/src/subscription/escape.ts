import { HtmlSubscription } from "@effect/ui/html";
import { Option } from "effect";

import { Message } from "../message.ts";

/**
 * Escape, unless something handled it first: the search input prevents the default of a key it
 * handles, so its own Escape clears the search and goes no further.
 */
export const escapeMessage = (event: {
  readonly key: string;
  readonly defaultPrevented: boolean;
}): Option.Option<Message> =>
  Option.liftPredicate(
    event,
    ({ defaultPrevented, key }) => key === "Escape" && !defaultPrevented,
  ).pipe(Option.map(() => Message.PressedEscape()));

/** The page's Escape, from the document Effect UI's host listens to. */
export const escapeSubscription = HtmlSubscription.onDocument("keydown", (event) =>
  Option.getOrUndefined(escapeMessage(event)),
);
