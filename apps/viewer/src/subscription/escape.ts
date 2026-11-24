import { Filter, Option, Stream } from "effect";
import { Subscription } from "foldkit";

import { Message } from "../message.ts";
import type { Model } from "../model.ts";

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

const escapes = Stream.suspend(() =>
  Stream.fromEventListener<KeyboardEvent>(document, "keydown").pipe(
    Stream.filterMap(Filter.fromPredicateOption(escapeMessage)),
  ),
);

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  escape: Subscription.persistentEntry(escapes),
}));
