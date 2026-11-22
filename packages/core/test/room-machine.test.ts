import { Cursor, Participant } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema } from "effect";
import { initialTransition, transition } from "xstate";

import { roomMachine } from "../src/index.ts";

const Member = Schema.Literals(["a", "b"]);
const Stranger = Schema.Literal("c");

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
  "a room lists each participant once, with cursors on the surface",
  [History],
  ([events]) => {
    Array.reduce(events, initialTransition(roomMachine)[0], (before, event) => {
      const [snapshot] = transition(roomMachine, before, event);
      const { participants } = snapshot.context;
      const ids = Array.map(participants, ({ id }) => id);
      expect(Array.dedupe(ids)).toStrictEqual(ids);
      Array.forEach(participants, ({ cursor }) => {
        if (cursor !== null) {
          expect(cursor.x).toBeGreaterThanOrEqual(0);
          expect(cursor.x).toBeLessThanOrEqual(1);
          expect(cursor.y).toBeGreaterThanOrEqual(0);
          expect(cursor.y).toBeLessThanOrEqual(1);
        }
      });
      if (event.type === "left") {
        expect(ids).not.toContain(event.id);
      }
      if (event.type === "moved") {
        const mover = Array.findFirst(participants, ({ id }) => id === event.id);
        if (Option.isSome(mover)) {
          expect(mover.value.cursor).not.toBeNull();
        }
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
