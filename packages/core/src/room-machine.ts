import { Participant, RoomEvents } from "@cairn/contract";
import { setupEffect } from "@xstate/effect";
import { Array, Option, Schema, Struct } from "effect";

export const roomMachine = setupEffect({
  schemas: {
    context: Schema.Struct({ participants: Schema.Array(Schema.toType(Participant)) }),
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
              event.participant,
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
                ? Struct.evolve(participant, { cursor: () => Option.some(event.cursor) })
                : participant,
            ),
          },
        }),
        read: ({ context, event }) => ({
          context: {
            participants: Array.map(context.participants, (participant) =>
              participant.id === event.id
                ? Struct.evolve(participant, { reading: () => Option.some(event.section) })
                : participant,
            ),
          },
        }),
      },
    },
  },
});
