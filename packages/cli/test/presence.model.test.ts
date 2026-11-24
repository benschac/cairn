import { createServer } from "node:http";

import { Cursor, CursorJson, ParticipantId, PresenceJson } from "@cairn/contract";
import type { Participant, ParticipantKind, Presence, RoomEvents } from "@cairn/contract";
import { roomMachine } from "@cairn/core";
import { NodeHttpServer, NodeSocket } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { assertTestCoverage, propertyTest, replayTest } from "@xstate/test";
import type { TestSut, TestSutSession } from "@xstate/test";
import { eventsFromSchemas, fromEffectSchema } from "@xstate/test/effect-schema";
import {
  Array,
  type Context,
  Effect,
  Equal,
  Exit,
  Function,
  HashMap,
  Layer,
  Match,
  Option,
  Record,
  Ref,
  Schema,
  Scope,
  Stream,
  String,
  SubscriptionRef,
} from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { Socket } from "effect/socket";
import * as fc from "fast-check";
import type { EventFrom, SnapshotFrom } from "xstate";

import { PresenceRoute, Room } from "../src/presence.ts";
import { leftOnClose } from "./fixtures/presence-left-on-close.ts";

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

// The room keeps cursors on the surface, so a cursor already on it arrives unchanged.
const OnSurface = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));
const SurfaceCursor = Cursor.mapFields(() => ({ x: OnSurface, y: OnSurface }));
// JSON turns -0 into 0, so the model gets the cursor as the wire carries it.
const onTheWire = Function.flow(Schema.encodeSync(CursorJson), Schema.decodeSync(CursorJson));
const surfaceCursor = fromEffectSchema(SurfaceCursor).map(onTheWire);

/** The names a test uses for participants. The server names them p1, p2, ... itself. */
const pool = Array.map(["ada", "bo", "cy"], (name) => ParticipantId.make(name));

const arbitraries: Record<string, fc.Arbitrary<unknown>> = {
  ".cursor": surfaceCursor,
  ".id": fc.constantFrom(...pool),
  // The server starts every participant without a cursor.
  ".participant.cursor": fc.constant(Option.none()),
  ".participant.id": fc.constantFrom(...pool),
  // The name travels in a query, so it stays plain.
  ".participant.name": fc.stringMatching(/^[A-Za-z0-9]{1,8}$/),
};

const events = eventsFromSchemas(roomMachine, {
  override: (_ast, path) => Option.getOrUndefined(Record.get(arbitraries, path)),
});

type RoomEvent = {
  [Type in keyof typeof RoomEvents]: { readonly type: Type } & (typeof RoomEvents)[Type]["Type"];
}[keyof typeof RoomEvents];

/** What a participant sees of the room, with cursors as plain data. */
type Seen = ReadonlyArray<{
  readonly cursor: Cursor | null;
  readonly id: string;
  readonly kind: ParticipantKind;
  readonly name: string;
}>;

const seen = (participants: ReadonlyArray<Participant>, nameOf: (id: string) => string): Seen =>
  Array.map(participants, ({ cursor, id, kind, name }) => ({
    cursor: Option.getOrNull(cursor),
    id: nameOf(id),
    kind,
    name,
  }));

const everyoneSees = (participants: ReadonlyArray<Participant>) => {
  const room = seen(participants, Function.identity);
  return Record.fromIterableWith(participants, ({ id }) => [id, room]);
};

const openClient = Effect.fn("openClient")(function* (session: Scope.Scope, query: string) {
  const scope = yield* Scope.fork(session);
  const url = yield* HttpServer.addressFormattedWith((address) =>
    Effect.succeed(`${String.replace(/^http/, "ws")(address)}/presence?${query}`),
  );
  const socket = yield* Socket.makeWebSocket(url).pipe(Scope.provide(scope));
  const reader = yield* socket.reader.pipe(Scope.provide(scope));
  const writer = yield* socket.writer.pipe(Scope.provide(scope));
  const room = yield* SubscriptionRef.make(Option.none<Presence>());
  yield* Stream.fromEffectRepeat(reader.pull).pipe(
    Stream.flattenIterable,
    Stream.mapEffect((frame) => decodePresence(frame)),
    Stream.runForEach((presence) => SubscriptionRef.set(room, Option.some(presence))),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  const first = yield* SubscriptionRef.changes(room).pipe(
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.timeout("2 seconds"),
  );
  return { room, scope, serverId: first.value.you, writer };
});
type Client = Effect.Success<ReturnType<typeof openClient>>;

/** The presence server on a port of its own, and one real client for each participant in the room. */
const makeSession = (runWith: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const services = yield* Layer.buildWithScope(Server, scope);
    const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof Server>>) =>
      runWith(Effect.provideContext(effect, services));
    const clients = yield* Ref.make(HashMap.empty<ParticipantId, Client>());
    const expected = yield* Ref.make<ReadonlyArray<Participant>>([]);

    const close = (id: ParticipantId) =>
      Ref.get(clients).pipe(
        Effect.flatMap((open) =>
          Option.match(HashMap.get(open, id), {
            onNone: () => Effect.void,
            onSome: (client) => Scope.close(client.scope, Exit.void),
          }),
        ),
        Effect.andThen(Ref.update(clients, HashMap.remove(id))),
      );

    const perform = Match.type<RoomEvent>().pipe(
      Match.discriminator("type")("joined", ({ participant: { id, kind, name } }) =>
        close(id).pipe(
          Effect.andThen(openClient(scope, `name=${name}&kind=${kind}`)),
          Effect.flatMap((client) => Ref.update(clients, HashMap.set(id, client))),
        ),
      ),
      Match.discriminator("type")("left", ({ id }) => close(id)),
      Match.discriminator("type")("moved", ({ cursor, id }) =>
        Effect.all([Ref.get(clients), encodeCursor(cursor)]).pipe(
          Effect.flatMap(([open, json]) =>
            Option.match(HashMap.get(open, id), {
              onNone: () => Effect.void,
              onSome: (client) => client.writer.write(json),
            }),
          ),
        ),
      ),
      Match.exhaustive,
    );

    // The room a client has, with the server's IDs mapped back to the test's.
    const view = (open: HashMap.HashMap<ParticipantId, Client>, presence: Presence) =>
      seen(presence.participants, (serverId) =>
        HashMap.findFirst(open, (client) => client.serverId === serverId).pipe(
          Option.match({ onNone: () => serverId, onSome: ([id]) => id }),
        ),
      );

    // Waits for a client to have the room the model has, so `read` is the room that followed the last event.
    const settled = (open: HashMap.HashMap<ParticipantId, Client>, wanted: Seen, client: Client) =>
      SubscriptionRef.changes(client.room).pipe(
        Stream.filter(Option.isSome),
        Stream.filter((room) => Equal.equals(view(open, room.value), wanted)),
        Stream.runHead,
        Effect.timeoutOption("2 seconds"),
        Effect.andThen(SubscriptionRef.get(client.room)),
      );

    const read = Effect.gen(function* () {
      const open = yield* Ref.get(clients);
      const model = yield* Ref.get(expected);
      const wanted = seen(model, Function.identity);
      const rooms = yield* Effect.forEach(
        HashMap.toEntries(open),
        ([id, client]) =>
          settled(open, wanted, client).pipe(
            Effect.map(
              (room) =>
                [
                  id,
                  Option.match(room, {
                    onNone: () => [],
                    onSome: (presence) => view(open, presence),
                  }),
                ] as const,
            ),
          ),
        { concurrency: "unbounded" },
      );
      return Record.fromEntries(rooms);
    });

    return {
      dispose: () => run(Scope.close(scope, Exit.void)),
      read: () => run(read),
      send: (event, { snapshot }) =>
        run(
          Ref.set(expected, snapshot.context.participants).pipe(
            Effect.andThen(perform(event)),
            Effect.asVoid,
          ),
        ),
    } satisfies TestSutSession<SnapshotFrom<typeof roomMachine>, EventFrom<typeof roomMachine>>;
  });

const sutIn = (services: Context.Context<never>) => {
  const runWith = Effect.runPromiseWith(services);
  const sut: TestSut<SnapshotFrom<typeof roomMachine>, EventFrom<typeof roomMachine>> = {
    create: () => runWith(makeSession(runWith)),
    projectModel: (snapshot) => everyoneSees(snapshot.context.participants),
  };
  return sut;
};

// A failing run waits two seconds for each shrink attempt, so a failure needs the time to print.
it.live(
  "every participant sees the room the room machine holds",
  () =>
    Effect.gen(function* () {
      const services = yield* Effect.context();
      const sut = sutIn(services);
      const { coverage } = yield* Effect.promise(() =>
        propertyTest(roomMachine, { events, maxCommands: 12, numRuns: 25, seed: 1, sut }),
      );
      assertTestCoverage(coverage, { transitions: 1 });
    }),
  60_000,
);

// The shrunk failure of a server that did not leave when a socket closed: a participant joined
// twice under one name, and the first client stayed in the room.
it.live("a participant who joins again replaces their first client in everyone's room", () =>
  Effect.gen(function* () {
    const services = yield* Effect.context();
    const sut = sutIn(services);
    yield* Effect.promise(() => replayTest(roomMachine, leftOnClose, { expect: "pass", sut }));
  }),
);
