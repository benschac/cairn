import {
  ClientFrameJson,
  Reading,
  ParticipantId,
  ParticipantKind,
  PresenceJson,
} from "@cairn/contract";
import type { Cursor } from "@cairn/contract";
import { roomMachine } from "@cairn/core";
import { createEffectActor, send, snapshots } from "@xstate/effect";
import type { EffectActor } from "@xstate/effect";
import { Context, Effect, Layer, Match, Number, Option, Ref, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

const decodeFrame = Schema.decodeUnknownEffect(ClientFrameJson);
const isReading = Schema.is(Reading);

/** The room's event for what a participant sent: a reading, or else a cursor. */
const eventOf = (id: ParticipantId) => (frame: Cursor | Reading) =>
  Match.value(frame).pipe(
    Match.when(isReading, ({ reading }) => ({ id, section: reading, type: "read" as const })),
    Match.orElse((cursor) => ({ cursor, id, type: "moved" as const })),
  );
const encodePresence = Schema.encodeEffect(PresenceJson);

/** The query a client connects with. A missing or unusable value falls back instead of refusing the client. */
export const PresenceQuery = Schema.Struct({
  kind: ParticipantKind.pipe(
    Schema.catchDecoding(() => Effect.succeedNone),
    Schema.withDecodingDefaultType(Effect.succeed<ParticipantKind>("human")),
  ),
  name: Schema.OptionFromOptional(
    Schema.NonEmptyString.pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  ),
});
export type PresenceQuery = typeof PresenceQuery.Type;

export class Room extends Context.Service<
  Room,
  {
    readonly actor: EffectActor<typeof roomMachine>;
    /** Adds a participant for the life of the current scope and returns its id. */
    readonly join: (query: PresenceQuery) => Effect.Effect<ParticipantId, never, Scope.Scope>;
  }
>()("@cairn/cli/Room") {
  static readonly layer = Layer.effect(
    Room,
    Effect.gen(function* () {
      const actor = yield* createEffectActor(roomMachine);
      const count = yield* Ref.make(0);
      const join = Effect.fn("Room.join")(function* ({ kind, name }: PresenceQuery) {
        const n = yield* Ref.updateAndGet(count, Number.increment);
        const id = ParticipantId.make(`p${n}`);
        yield* Effect.acquireRelease(
          send(actor, {
            participant: {
              cursor: Option.none(),
              id,
              kind,
              name: Option.getOrElse(name, () => `Guest ${n}`),
              reading: Option.none(),
            },
            type: "joined",
          }),
          () => send(actor, { id, type: "left" }),
        );
        return id;
      });
      return Room.of({ actor, join });
    }),
  );
}

export const PresenceRoute = HttpRouter.add("GET", "/presence", (request) =>
  Effect.gen(function* () {
    const room = yield* Room;
    const query = yield* HttpRouter.schemaParams(PresenceQuery);
    const socket = yield* request.upgrade;
    const writer = yield* socket.writer;
    const reader = yield* socket.reader;
    const id = yield* room.join(query);

    yield* snapshots(room.actor).pipe(
      Stream.mapEffect((snapshot) =>
        encodePresence({ participants: snapshot.context.participants, you: id }),
      ),
      Stream.runForEach((json) => writer.write(json)),
      Effect.forkScoped,
    );

    // A pull fails once the socket closes, which ends the connection.
    yield* reader.pull.pipe(
      Effect.flatMap((frames) =>
        Effect.forEach(
          frames,
          (frame) =>
            decodeFrame(frame).pipe(
              Effect.flatMap((sent) => send(room.actor, eventOf(id)(sent))),
              Effect.ignore({
                log: "Debug",
                message: "Ignored a frame that is not a cursor or a reading",
              }),
            ),
          { discard: true },
        ),
      ),
      Effect.forever,
      Effect.catchTag("SocketError", () => Effect.void),
    );

    return HttpServerResponse.empty();
  }).pipe(Effect.scoped),
);
