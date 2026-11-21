import { Cursor, Participant } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { initialTransition, transition } from "xstate";

import { roomMachine } from "../src/index.ts";

const RoomEvent = Schema.Union([
  Schema.Struct({ participant: Participant, type: Schema.Literal("joined") }),
  Schema.Struct({ id: Schema.Literals(["a", "b", "c"]), type: Schema.Literal("left") }),
  Schema.Struct({
    cursor: Cursor,
    id: Schema.Literals(["a", "b", "c"]),
    type: Schema.Literal("moved"),
  }),
]);

const Known = Schema.Struct({
  ...Participant.fields,
  id: Schema.Literals(["a", "b", "c"]),
});

const History = Schema.Array(
  Schema.Union([
    Schema.Struct({ participant: Known, type: Schema.Literal("joined") }),
    ...RoomEvent.members.slice(1),
  ]),
);

it.prop(
  "a room lists each participant once, with cursors on the surface",
  [History],
  ([events]) => {
    let [snapshot] = initialTransition(roomMachine);
    for (const event of events) {
      [snapshot] = transition(roomMachine, snapshot, event);
      const { participants } = snapshot.context;
      expect(new Set(participants.map((participant) => participant.id)).size).toBe(
        participants.length,
      );
      for (const { cursor } of participants) {
        if (cursor !== null) {
          expect(cursor.x).toBeGreaterThanOrEqual(0);
          expect(cursor.x).toBeLessThanOrEqual(1);
          expect(cursor.y).toBeGreaterThanOrEqual(0);
          expect(cursor.y).toBeLessThanOrEqual(1);
        }
      }
      if (event.type === "left") {
        expect(participants.map((participant) => participant.id)).not.toContain(event.id);
      }
      if (
        event.type === "moved" &&
        participants.some((participant) => participant.id === event.id)
      ) {
        expect(
          participants.find((participant) => participant.id === event.id)?.cursor,
        ).not.toBeNull();
      }
    }
  },
);
