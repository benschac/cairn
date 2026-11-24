import { Cursor, Participant, PrdSectionId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, Struct } from "effect";
import { initialTransition, transition } from "xstate";

import { roomMachine } from "../src/index.ts";

const Member = Schema.Literals(["a", "b"]).pipe(Schema.brand("ParticipantId"));
const Stranger = Schema.Literal("c").pipe(Schema.brand("ParticipantId"));

const eventsFor = <Id extends Schema.Top>(id: Id) =>
  [
    Schema.Struct({ id, type: Schema.Literal("left") }),
    Schema.Struct({ cursor: Cursor, id, type: Schema.Literal("moved") }),
    Schema.Struct({ id, section: PrdSectionId, type: Schema.Literal("read") }),
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

it.prop(
  "a read sets that participant's section and nothing else, and leaves every cursor where it was",
  [History, Member, PrdSectionId],
  ([events, id, section]) => {
    const before = replay(events);
    const [after] = transition(roomMachine, before, { id, section, type: "read" });
    const wasPresent = Array.some(
      before.context.participants,
      (participant) => participant.id === id,
    );
    expect(Array.map(after.context.participants, (participant) => participant.id)).toStrictEqual(
      Array.map(before.context.participants, (participant) => participant.id),
    );
    Array.forEach(
      Array.zip(before.context.participants, after.context.participants),
      ([was, now]) => {
        // Everything but the section is as it was, for the reader and for everyone else.
        expect(Struct.omit(now, ["reading"])).toStrictEqual(Struct.omit(was, ["reading"]));
        expect(now.reading).toStrictEqual(now.id === id ? Option.some(section) : was.reading);
      },
    );
    expect(wasPresent).toBe(
      Array.some(after.context.participants, (participant) => participant.id === id),
    );
  },
);

it.prop(
  "a participant reads one section at a time: the last read is the one the room keeps",
  [History, Member, PrdSectionId, PrdSectionId],
  ([events, id, first, second]) => {
    const [afterFirst] = transition(roomMachine, replay(events), {
      id,
      section: first,
      type: "read",
    });
    const [afterSecond] = transition(roomMachine, afterFirst, {
      id,
      section: second,
      type: "read",
    });
    const reading = Array.findFirst(
      afterSecond.context.participants,
      (participant) => participant.id === id,
    );
    expect(Option.map(reading, (participant) => participant.reading)).toStrictEqual(
      Option.map(reading, () => Option.some(second)),
    );
  },
);
