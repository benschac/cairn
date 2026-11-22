import { Schema } from "effect";

import { SectionId, TaskId } from "./ids.ts";

export * from "./ids.ts";
export * from "./manifest.ts";
export * from "./trailers.ts";

export const Task = Schema.Struct({
  gated: Schema.Boolean,
  id: TaskId,
  section: SectionId,
  title: Schema.NonEmptyString,
});
export type Task = typeof Task.Type;

export const TaskEvents = {
  approve: Schema.Struct({}),
  finish: Schema.Struct({}),
  land: Schema.Struct({}),
  start: Schema.Struct({}),
};

export const TaskEventType = Schema.Literals(["approve", "finish", "land", "start"]);
export type TaskEventType = typeof TaskEventType.Type;

export const ParticipantKind = Schema.Literals(["human", "agent"]);
export type ParticipantKind = typeof ParticipantKind.Type;

export const Cursor = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type Cursor = typeof Cursor.Type;

export const Participant = Schema.Struct({
  cursor: Schema.NullOr(Cursor),
  id: Schema.NonEmptyString,
  kind: ParticipantKind,
  name: Schema.NonEmptyString,
});
export type Participant = typeof Participant.Type;

export const RoomEvents = {
  joined: Schema.Struct({ participant: Participant }),
  left: Schema.Struct({ id: Schema.NonEmptyString }),
  moved: Schema.Struct({ cursor: Cursor, id: Schema.NonEmptyString }),
};

export const Presence = Schema.Struct({
  participants: Schema.Array(Participant),
  you: Schema.NonEmptyString,
});
export type Presence = typeof Presence.Type;

export const PresenceJson = Schema.fromJsonString(Presence);
export const CursorJson = Schema.fromJsonString(Cursor);
