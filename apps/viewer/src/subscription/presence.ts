import { CursorJson, PresenceJson } from "@cairn/contract";
import type { Cursor } from "@cairn/contract";
import { Effect, Filter, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { cursorOf, paneViewportOf } from "../canvas.ts";
import { rectOf } from "../geometry.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";

const decodePresence = Schema.decodeUnknownOption(PresenceJson);
// A cursor is two finite numbers and always encodes, so the encoder cannot fail, as with the
// viewport attribute in canvas.ts.
const encodeCursor = Schema.encodeSync(CursorJson);

const presenceUrl = () =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/presence${location.search}`;

const openSocket = Effect.acquireRelease(
  Effect.sync(() => new WebSocket(presenceUrl())),
  (socket) => Effect.sync(() => socket.close()),
);

const presenceUpdates = (socket: WebSocket) =>
  Stream.fromEventListener<MessageEvent>(socket, "message").pipe(
    Stream.filterMap(Filter.fromPredicateOption((event) => decodePresence(event.data))),
    Stream.map((presence) => Message.ReceivedPresence({ presence })),
  );

/**
 * The canvas point under the pointer, read with the viewport the model last gave the pane, so the
 * stream does not restart while someone pans. None while there is no pane or the pointer is off it.
 */
const cursorAt = (event: PointerEvent): Option.Option<Cursor> =>
  Option.flatMap(Option.fromNullOr(document.querySelector("[data-canvas]")), (pane) =>
    cursorOf(
      { x: event.clientX, y: event.clientY },
      rectOf(pane.getBoundingClientRect()),
      paneViewportOf(pane),
    ),
  );

const sendCursor = (socket: WebSocket) => (cursor: Cursor) =>
  Effect.sync(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encodeCursor(cursor));
    }
  });

const sendCursorMoves = (socket: WebSocket) =>
  Stream.fromEventListener<PointerEvent>(document, "pointermove").pipe(
    Stream.filterMap(Filter.fromPredicateOption(cursorAt)),
    Stream.mapEffect(sendCursor(socket)),
    Stream.drain,
  );

const presenceMessages = Stream.unwrap(
  Effect.map(openSocket, (socket) =>
    Stream.merge(presenceUpdates(socket), sendCursorMoves(socket)),
  ),
);

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  presence: Subscription.persistentEntry(presenceMessages),
}));
