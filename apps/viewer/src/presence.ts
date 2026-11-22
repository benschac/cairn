import { CursorJson, PresenceJson } from "@cairn/contract";
import type { Cursor } from "@cairn/contract";
import { Effect, Filter, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { VIEWPORT_ATTRIBUTE, cursorOf, originViewport, viewportOfAttribute } from "./canvas.ts";
import { rectOf } from "./layout.ts";
import { Message } from "./main.ts";
import type { Model } from "./model.ts";

const decodePresence = Schema.decodeUnknownOption(PresenceJson);
const encodeCursor = Schema.encodeEffect(CursorJson);

const presenceUrl = () =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/presence${location.search}`;

const openSocket = Effect.acquireRelease(
  Effect.sync(() => new WebSocket(presenceUrl())),
  (socket) => Effect.sync(() => socket.close()),
);

const receivedPresence = (socket: WebSocket) =>
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
      Option.getOrElse(
        viewportOfAttribute(pane.getAttribute(VIEWPORT_ATTRIBUTE)),
        () => originViewport,
      ),
    ),
  );

const sendCursor = (socket: WebSocket) => (cursor: Cursor) =>
  encodeCursor(cursor).pipe(
    Effect.flatMap((frame) =>
      Effect.sync(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(frame);
        }
      }),
    ),
    Effect.ignore,
  );

const sentCursors = (socket: WebSocket) =>
  Stream.fromEventListener<PointerEvent>(document, "pointermove").pipe(
    Stream.filterMap(Filter.fromPredicateOption(cursorAt)),
    Stream.mapEffect(sendCursor(socket)),
    Stream.drain,
  );

const presenceMessages = Stream.unwrap(
  Effect.map(openSocket, (socket) => Stream.merge(receivedPresence(socket), sentCursors(socket))),
);

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  presence: Subscription.persistentEntry(presenceMessages),
}));
