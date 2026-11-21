import { CursorJson, ParticipantKind, PresenceJson } from "@cairn/contract";
import { roomMachine } from "@cairn/core";
import { createEffectActor, send, snapshots } from "@xstate/effect";
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

const decodeCursor = Schema.decodeUnknownEffect(CursorJson);
const encodePresence = Schema.encodeEffect(PresenceJson);
const decodeKind = Schema.decodeUnknownOption(ParticipantKind);

export class Room extends Context.Service<
  Room,
  {
    readonly actor: Effect.Success<ReturnType<typeof createEffectActor<typeof roomMachine>>>;
    readonly nextId: Effect.Effect<string>;
  }
>()("@cairn/cli/Room") {
  static readonly layer = Layer.effect(
    Room,
    Effect.gen(function* () {
      const actor = yield* createEffectActor(roomMachine);
      const count = yield* Ref.make(0);
      return Room.of({
        actor,
        nextId: Ref.updateAndGet(count, (n) => n + 1).pipe(Effect.map((n) => `p${n}`)),
      });
    }),
  );
}

export const PresenceRoute = HttpRouter.add("GET", "/presence", (request) =>
  Effect.gen(function* () {
    const room = yield* Room;
    const socket = yield* request.upgrade;
    const writer = yield* socket.writer;
    const reader = yield* socket.reader;
    const id = yield* room.nextId;
    const query = new URL(request.url, "http://cairn.local").searchParams;
    const kind = decodeKind(query.get("kind"));

    yield* Effect.addFinalizer(() => send(room.actor, { id, type: "left" }));
    yield* send(room.actor, {
      participant: {
        cursor: null,
        id,
        kind: Option.getOrElse(kind, () => "human" as const),
        name: query.get("name") || `Guest ${id.slice(1)}`,
      },
      type: "joined",
    });

    yield* snapshots(room.actor).pipe(
      Stream.mapEffect((snapshot) =>
        encodePresence({ participants: snapshot.context.participants, you: id }),
      ),
      Stream.runForEach((json) => writer.write(json)),
      Effect.forkScoped,
    );

    yield* reader.pull.pipe(
      Effect.flatMap((frames) =>
        Effect.forEach(frames, (frame) =>
          decodeCursor(frame).pipe(
            Effect.flatMap((cursor) => send(room.actor, { cursor, id, type: "moved" })),
            Effect.ignore,
          ),
        ),
      ),
      Effect.forever,
      Effect.ignore,
    );

    return HttpServerResponse.empty();
  }).pipe(Effect.scoped),
);
