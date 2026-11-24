import { Schema } from "effect";

import { SectionId, TaskId } from "./ids.ts";

export * from "./config.ts";
export * from "./ids.ts";
export * from "./manifest.ts";
export * from "./session.ts";
export * from "./spec-index.ts";
export * from "./task-draft.ts";
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
  fail: Schema.Struct({}),
  finish: Schema.Struct({}),
  land: Schema.Struct({}),
  start: Schema.Struct({}),
};

export const TaskEventType = Schema.Literals(["approve", "fail", "finish", "land", "start"]);
export type TaskEventType = typeof TaskEventType.Type;

export const ParticipantKind = Schema.Literals(["human", "agent"]);
export type ParticipantKind = typeof ParticipantKind.Type;

export const Cursor = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type Cursor = typeof Cursor.Type;

/** A participant's id, handed out by the room. */
export const ParticipantId = Schema.NonEmptyString.pipe(Schema.brand("ParticipantId"));
export type ParticipantId = typeof ParticipantId.Type;

/** A participant. The wire carries a missing cursor as `null`; decoded, it is an `Option`. */
export const Participant = Schema.Struct({
  cursor: Schema.OptionFromNullOr(Cursor),
  id: ParticipantId,
  kind: ParticipantKind,
  name: Schema.NonEmptyString,
});
export type Participant = typeof Participant.Type;

/** The room machine's events. A machine validates decoded values, so they carry the participant as its type. */
export const RoomEvents = {
  joined: Schema.Struct({ participant: Schema.toType(Participant) }),
  left: Schema.Struct({ id: ParticipantId }),
  moved: Schema.Struct({ cursor: Cursor, id: ParticipantId }),
};

export const Presence = Schema.Struct({
  participants: Schema.Array(Participant),
  you: ParticipantId,
});
export type Presence = typeof Presence.Type;

export const PresenceJson = Schema.fromJsonString(Presence);
export const CursorJson = Schema.fromJsonString(Cursor);

export * from "./events.ts";
export * from "./judgments.ts";
export * from "./trace.ts";
