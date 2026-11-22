import { Participant, RoomEvents } from "@cairn/contract";
import type { Cursor } from "@cairn/contract";
import { setupEffect } from "@xstate/effect";
import { Array, Number, Schema, Struct } from "effect";

const toSurface = Number.clamp({ maximum: 1, minimum: 0 });

const onSurface = (cursor: Cursor): Cursor => Struct.evolve(cursor, { x: toSurface, y: toSurface });

export const roomMachine = setupEffect({
  schemas: {
    context: Schema.Struct({ participants: Schema.Array(Participant) }),
    events: RoomEvents,
  },
}).createMachine({
  context: { participants: [] },
  id: "room",
  initial: "open",
  states: {
    open: {
      on: {
        joined: ({ context, event }) => ({
          context: {
            participants: Array.append(
              Array.filter(context.participants, ({ id }) => id !== event.participant.id),
              Struct.evolve(event.participant, {
                cursor: (cursor) => (cursor === null ? null : onSurface(cursor)),
              }),
            ),
          },
        }),
        left: ({ context, event }) => ({
          context: {
            participants: Array.filter(context.participants, ({ id }) => id !== event.id),
          },
        }),
        moved: ({ context, event }) => ({
          context: {
            participants: Array.map(context.participants, (participant) =>
              participant.id === event.id
                ? { ...participant, cursor: onSurface(event.cursor) }
                : participant,
            ),
          },
        }),
      },
    },
  },
});
