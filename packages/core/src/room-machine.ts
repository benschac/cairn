import { Participant, RoomEvents } from "@cairn/contract";
import type { Cursor } from "@cairn/contract";
import { setupEffect } from "@xstate/effect";
import { Schema } from "effect";

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const onSurface = (cursor: Cursor): Cursor => ({
  x: clamp(cursor.x),
  y: clamp(cursor.y),
});

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
            participants: [
              ...context.participants.filter(
                (participant) => participant.id !== event.participant.id,
              ),
              {
                ...event.participant,
                cursor:
                  event.participant.cursor === null ? null : onSurface(event.participant.cursor),
              },
            ],
          },
        }),
        left: ({ context, event }) => ({
          context: {
            participants: context.participants.filter((participant) => participant.id !== event.id),
          },
        }),
        moved: ({ context, event }) => ({
          context: {
            participants: context.participants.map((participant) =>
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
