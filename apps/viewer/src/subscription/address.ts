import { Effect, Option, Queue, Stream, String } from "effect";

import { Message } from "../message.ts";
import { UrlRequest, urlFromString, type Url } from "../url.ts";
import { inPage } from "./page.ts";

/** The main mouse button. */
const PRIMARY_BUTTON = 0;

/** The page's address, as `ChangedUrl` carries it. */
const currentUrl = (): Option.Option<Url> => urlFromString(window.location.href);

/**
 * What a click on an anchor asks for, as a browser router reads it: none for a click with
 * another button or a modifier key, one something already handled, an anchor that opens elsewhere
 * or downloads, or a click on no anchor; otherwise the anchor's address, internal when it has the
 * page's origin.
 */
export const linkRequestOf = (event: MouseEvent): Option.Option<UrlRequest> =>
  Option.liftPredicate(
    event,
    ({ altKey, button, ctrlKey, defaultPrevented, metaKey, shiftKey }) =>
      button === PRIMARY_BUTTON &&
      !altKey &&
      !ctrlKey &&
      !metaKey &&
      !shiftKey &&
      !defaultPrevented,
  ).pipe(
    Option.flatMap(({ target }) =>
      target instanceof Element ? Option.some(target) : Option.none(),
    ),
    Option.flatMapNullishOr((target) => target.closest("a")),
    Option.filter(
      (anchor) =>
        String.isNonEmpty(anchor.href) &&
        (String.isEmpty(anchor.target) || anchor.target === "_self") &&
        !anchor.hasAttribute("download"),
    ),
    Option.map((anchor) =>
      Option.match(
        Option.filter(urlFromString(anchor.href), () => anchor.origin === location.origin),
        {
          onNone: () => UrlRequest.External({ href: anchor.href }),
          onSome: (url) => UrlRequest.Internal({ url }),
        },
      ),
    ),
  );

/** Back, Forward, or a followed fragment: the address the page moved to. */
const urlChanges = Stream.suspend(() =>
  Stream.fromEventListener<PopStateEvent>(window, "popstate").pipe(
    Stream.map(currentUrl),
    Stream.filter(Option.isSome),
    Stream.map(({ value: url }) => Message.ChangedUrl({ url })),
  ),
);

/**
 * A click on an anchor, kept from the browser and sent as `ClickedLink`. The listener cancels the
 * click as it is dispatched, which a stream of events read later could not.
 */
const clickedLink = (queue: Queue.Enqueue<Message>) => (event: MouseEvent) =>
  Option.map(linkRequestOf(event), (request) => {
    event.preventDefault();
    Queue.offerUnsafe(queue, Message.ClickedLink({ request }));
  });

const linkClicks = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listener = clickedLink(queue);
      document.addEventListener("click", listener);
      return listener;
    }),
    (listener) => Effect.sync(() => document.removeEventListener("click", listener)),
  ),
);

/**
 * The viewer owns the address: Back, Forward and a fragment
 * followed arrive as `ChangedUrl`, and a click on an anchor as `ClickedLink`, which goes where
 * the browser would take it. The viewer writes history itself (`PushUrl`, `ReplaceUrl`), so no
 * Router stands between it and `window.history`.
 */
export const addressMessages: Stream.Stream<Message> = inPage(Stream.merge(urlChanges, linkClicks));
