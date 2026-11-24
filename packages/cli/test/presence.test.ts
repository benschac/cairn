import { createServer } from "node:http";

import {
  Cursor,
  CursorJson,
  ParticipantKind,
  PrdSectionId,
  PresenceJson,
  ReadingJson,
} from "@cairn/contract";
import type { Presence } from "@cairn/contract";
import { NodeHttpServer, NodeSocket } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, Effect, Layer, Option, Schema, Stream, String, Struct } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { Socket } from "effect/socket";

import { PresenceRoute, Room } from "../src/presence.ts";

const Server = HttpRouter.serve(PresenceRoute, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provide(Room.layer),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
  Layer.provideMerge(NodeSocket.layerWebSocketConstructor),
);

const decodePresence = Schema.decodeUnknownEffect(PresenceJson);
const encodeCursor = Schema.encodeEffect(CursorJson);
const decodeCursor = Schema.decodeEffect(CursorJson);
const encodeReading = Schema.encodeEffect(ReadingJson);

// The room keeps cursors on the surface, so a cursor already on it arrives unchanged.
const OnSurface = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));
const SurfaceCursor = Cursor.mapFields(() => ({ x: OnSurface, y: OnSurface }));

const join = Effect.fn("join")(function* (query: string) {
  const url = yield* HttpServer.addressFormattedWith((address) =>
    Effect.succeed(`${String.replace(/^http/, "ws")(address)}/presence?${query}`),
  );
  const socket = yield* Socket.makeWebSocket(url);
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  const presences = Stream.fromEffectRepeat(reader.pull).pipe(
    Stream.flattenIterable,
    Stream.mapEffect((frame) => decodePresence(frame)),
  );
  const sees = (matches: (presence: Presence) => boolean) =>
    presences.pipe(
      Stream.filter(matches),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
      Effect.timeout("2 seconds"),
    );
  // Sends a cursor and returns it as the wire carries it: JSON turns -0 into 0.
  const moves = (cursor: Cursor) =>
    encodeCursor(cursor).pipe(Effect.tap(writer.write), Effect.flatMap(decodeCursor));
  // Sends the section this client is reading.
  const reads = (reading: PrdSectionId) =>
    encodeReading({ reading }).pipe(Effect.flatMap(writer.write));
  return { moves, reads, sees, writer };
});

const someoneMoved = (presence: Presence) =>
  Array.some(presence.participants, (participant) => Option.isSome(participant.cursor));

it.live.prop(
  "a participant sees another's kind and cursor past frames that are not cursors, then sees them leave",
  { cursor: SurfaceCursor, kind: ParticipantKind },
  ({ cursor, kind }) =>
    Effect.gen(function* () {
      const planner = yield* join("name=Planner");

      yield* Effect.gen(function* () {
        const other = yield* join(`name=Ada&kind=${kind}`);
        yield* other.writer.write("not a cursor");
        yield* other.writer.write(new Uint8Array([1, 2, 3]));
        const sent = yield* other.moves(cursor);

        const seen = yield* planner.sees(someoneMoved);
        expect(
          Array.map(seen.participants, (participant) => Struct.omit(participant, ["id"])),
        ).toEqual([
          { cursor: Option.none(), kind: "human", name: "Planner", reading: Option.none() },
          { cursor: Option.some(sent), kind, name: "Ada", reading: Option.none() },
        ]);
      }).pipe(Effect.scoped);

      const alone = yield* planner.sees((presence) => presence.participants.length === 1);
      expect(Array.map(alone.participants, (participant) => participant.name)).toEqual(["Planner"]);
    }).pipe(Effect.provide(Server)),
  // Each run starts a server and two sockets. The default 100 runs take about 4 s when the whole
  // check runs beside them, which is the test's limit; 20 still covers both kinds and many cursors.
  { arbitrary: { runs: 20 } },
);

it.live("a client without a usable name or kind joins as a numbered human guest", () =>
  Effect.gen(function* () {
    const guest = yield* join("name=&kind=robot");
    const seen = yield* guest.sees((presence) => presence.participants.length === 1);
    expect(seen.participants).toEqual([
      {
        cursor: Option.none(),
        id: seen.you,
        kind: "human",
        name: `Guest ${String.slice(1)(seen.you)}`,
        reading: Option.none(),
      },
    ]);
  }).pipe(Effect.provide(Server)),
);

/** What the named participant is reading in a room, if they are in it. */
const readingOf = (name: string) => (presence: Presence) =>
  Array.findFirst(presence.participants, (participant) => participant.name === name).pipe(
    Option.flatMap((participant) => participant.reading),
  );

const someoneReads = (presence: Presence) =>
  Array.some(presence.participants, (participant) => Option.isSome(participant.reading));

it.live.prop(
  "a participant sees what another is reading, and the next section replaces it",
  { first: PrdSectionId, second: PrdSectionId },
  ({ first, second }) =>
    Effect.gen(function* () {
      const planner = yield* join("name=Planner");
      const ada = yield* join("name=Ada");

      yield* ada.reads(first);
      const seen = yield* planner.sees((presence) => Option.isSome(readingOf("Ada")(presence)));
      expect(readingOf("Ada")(seen)).toEqual(Option.some(first));
      // Only the one who sent it is reading, and nobody's cursor moved.
      expect(readingOf("Planner")(seen)).toEqual(Option.none());
      expect(
        Array.some(seen.participants, (participant) => Option.isSome(participant.cursor)),
      ).toBe(false);

      yield* ada.reads(second);
      const later = yield* planner.sees((presence) =>
        Option.contains(readingOf("Ada")(presence), second),
      );
      expect(readingOf("Ada")(later)).toEqual(Option.some(second));
    }).pipe(Effect.provide(Server)),
);

it.live("a frame that names no PRD section is not a reading", () =>
  Effect.gen(function* () {
    const planner = yield* join("name=Planner");
    const ada = yield* join("name=Ada");
    yield* ada.writer.write('{"reading":"spec.format"}');
    yield* ada.writer.write('{"reading":3}');
    yield* ada.reads(PrdSectionId.make("prd.goal"));
    // Frames arrive in order, so once the good one shows the two before it were dropped.
    const seen = yield* planner.sees(someoneReads);
    expect(Array.getSomes(Array.map(seen.participants, ({ reading }) => reading))).toEqual([
      "prd.goal",
    ]);
  }).pipe(Effect.provide(Server)),
);
