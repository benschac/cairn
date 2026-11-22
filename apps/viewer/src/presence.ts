import { CursorJson, PresenceJson } from "@cairn/contract";
import { Effect, Filter, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

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

const sendCursor = (socket: WebSocket) => (event: PointerEvent) =>
  encodeCursor({
    x: event.clientX / window.innerWidth,
    y: event.clientY / window.innerHeight,
  }).pipe(
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
    Stream.mapEffect(sendCursor(socket)),
    Stream.drain,
  );

const presenceMessages = Stream.unwrap(
  Effect.map(openSocket, (socket) => Stream.merge(receivedPresence(socket), sentCursors(socket))),
);

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  presence: entry(
    { live: Schema.Boolean },
    {
      dependenciesToStream: () => presenceMessages,
      modelToDependencies: () => ({ live: true }),
    },
  ),
}));
