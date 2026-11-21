import { createServer } from "node:http";

import { PresenceJson } from "@cairn/contract";
import type { Presence } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Queue, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { PresenceRoute, Room } from "../src/presence.ts";

const Server = HttpRouter.serve(PresenceRoute, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provide(Room.layer),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
);

const decodePresence = Schema.decodeUnknownEffect(PresenceJson);

const join = Effect.fn("join")(function* (query: string) {
  const server = yield* HttpServer.HttpServer;
  const port = "port" in server.address ? server.address.port : 0;
  const frames = yield* Queue.unbounded<string>();
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => new WebSocket(`ws://127.0.0.1:${port}/presence?${query}`)),
    (open) => Effect.sync(() => open.close()),
  );
  socket.addEventListener("message", (event) => {
    Queue.offerUnsafe(frames, String(event.data));
  });
  yield* Effect.callback<void>((resume) => {
    socket.addEventListener("open", () => resume(Effect.void));
  });
  const sees = (matches: (presence: Presence) => boolean) =>
    Queue.take(frames).pipe(
      Effect.flatMap(decodePresence),
      Effect.repeat({ until: matches }),
      Effect.timeout("2 seconds"),
    );
  return { sees, socket };
});

it.live("two participants see each other's cursor, and a departure", () =>
  Effect.gen(function* () {
    const planner = yield* join("name=Planner&kind=agent");

    yield* Effect.gen(function* () {
      const ada = yield* join("name=Ada");
      ada.socket.send(JSON.stringify({ x: 0.25, y: 0.5 }));

      const seen = yield* planner.sees((presence) =>
        presence.participants.some((participant) => participant.cursor !== null),
      );
      expect(seen.participants.map(({ cursor, kind, name }) => ({ cursor, kind, name }))).toEqual([
        { cursor: null, kind: "agent", name: "Planner" },
        { cursor: { x: 0.25, y: 0.5 }, kind: "human", name: "Ada" },
      ]);
    }).pipe(Effect.scoped);

    const alone = yield* planner.sees((presence) => presence.participants.length === 1);
    expect(alone.participants.map((participant) => participant.name)).toEqual(["Planner"]);
  }).pipe(Effect.provide(Server)),
);
