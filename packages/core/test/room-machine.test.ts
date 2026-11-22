import { Cursor, Participant } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema } from "effect";
import { initialTransition, transition } from "xstate";

import { roomMachine } from "../src/index.ts";

const Member = Schema.Literals(["a", "b"]).pipe(Schema.brand("ParticipantId"));
const Stranger = Schema.Literal("c").pipe(Schema.brand("ParticipantId"));

const eventsFor = <Id extends Schema.Top>(id: Id) =>
  [
    Schema.Struct({ id, type: Schema.Literal("left") }),
    Schema.Struct({ cursor: Cursor, id, type: Schema.Literal("moved") }),
  ] as const;

const History = Schema.Array(
  Schema.Union(
    Array.prepend(
      eventsFor(Schema.Union([Member, Stranger])),
      Schema.Struct({
        participant: Schema.Struct({ ...Participant.fields, id: Member }),
        type: Schema.Literal("joined"),
      }),
    ),
  ),
);

const StrangerEvent = Schema.Union(eventsFor(Stranger));

const replay = (events: typeof History.Type) =>
  Array.reduce(
    events,
    initialTransition(roomMachine)[0],
    (snapshot, event) => transition(roomMachine, snapshot, event)[0],
  );

it.prop(
  "a room lists each participant once, and keeps cursors where they were sent, off the unit square too",
  [History],
  ([events]) => {
    Array.reduce(events, initialTransition(roomMachine)[0], (before, event) => {
      const [snapshot] = transition(roomMachine, before, event);
      const { participants } = snapshot.context;
      const ids = Array.map(participants, ({ id }) => id);
      expect(Array.dedupe(ids)).toStrictEqual(ids);
      const find = (id: string) =>
        Array.findFirst(participants, (participant) => participant.id === id);
      if (event.type === "joined") {
        expect(find(event.participant.id)).toStrictEqual(Option.some(event.participant));
      }
      if (event.type === "left") {
        expect(ids).not.toContain(event.id);
      }
      // A known participant's cursor is exactly the one sent; an unknown id adds nobody.
      if (event.type === "moved") {
        const wasPresent = Array.some(before.context.participants, ({ id }) => id === event.id);
        expect(Option.map(find(event.id), ({ cursor }) => cursor)).toStrictEqual(
          wasPresent ? Option.some(Option.some(event.cursor)) : Option.none(),
        );
      }
      return snapshot;
    });
  },
);

it.prop(
  "a room ignores events about someone who is not in it",
  [History, StrangerEvent],
  ([events, stranger]) => {
    const before = replay(events);
    const [after] = transition(roomMachine, before, stranger);
    expect(after.value).toBe("open");
    expect(after.context).toStrictEqual(before.context);
  },
);
