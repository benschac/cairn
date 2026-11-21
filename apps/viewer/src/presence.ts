import { PresenceJson } from "@cairn/contract";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { Message } from "./main.ts";
import type { Model } from "./model.ts";

const decodePresence = Schema.decodeUnknownOption(PresenceJson);

const presenceUrl = () =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/presence${location.search}`;

const presenceMessages = Stream.callback<typeof Message.ReceivedPresence.Type>((queue) => {
  const handleFrame = (event: MessageEvent) => {
    const presence = decodePresence(event.data);
    if (Option.isSome(presence)) {
      Queue.offerUnsafe(queue, Message.ReceivedPresence({ presence: presence.value }));
    }
  };
  return Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocket(presenceUrl());
      const handleMove = (event: PointerEvent) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              x: event.clientX / window.innerWidth,
              y: event.clientY / window.innerHeight,
            }),
          );
        }
      };
      socket.addEventListener("message", handleFrame);
      document.addEventListener("pointermove", handleMove);
      return { handleMove, socket };
    }),
    ({ handleMove, socket }) =>
      Effect.sync(() => {
        document.removeEventListener("pointermove", handleMove);
        socket.removeEventListener("message", handleFrame);
        socket.close();
      }),
  ).pipe(Effect.flatMap(() => Effect.never));
});

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  presence: entry(
    { live: Schema.Boolean },
    {
      dependenciesToStream: () => presenceMessages,
      modelToDependencies: () => ({ live: true }),
    },
  ),
}));
