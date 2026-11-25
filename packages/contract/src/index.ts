import { Schema } from "effect";

import { PrdSectionId } from "./ids.ts";

export * from "./config.ts";

export * from "./ids.ts";
export * from "./link.ts";
export * from "./manifest.ts";
export * from "./section.ts";
export * from "./session.ts";
export * from "./spec-index.ts";
export * from "./task-draft.ts";
export * from "./trailers.ts";

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

/**
 * A participant. The wire carries a missing cursor or reading as `null`; decoded, each is an
 * `Option`. `reading` is the PRD section that is current in the participant's window.
 */
export const Participant = Schema.Struct({
  cursor: Schema.OptionFromNullOr(Cursor),
  id: ParticipantId,
  kind: ParticipantKind,
  name: Schema.NonEmptyString,
  reading: Schema.OptionFromNullOr(PrdSectionId),
});
export type Participant = typeof Participant.Type;

/** The room machine's events. A machine validates decoded values, so they carry the participant as its type. */
export const RoomEvents = {
  joined: Schema.Struct({ participant: Schema.toType(Participant) }),
  left: Schema.Struct({ id: ParticipantId }),
  moved: Schema.Struct({ cursor: Cursor, id: ParticipantId }),
  read: Schema.Struct({ id: ParticipantId, section: PrdSectionId }),
};

export const Presence = Schema.Struct({
  participants: Schema.Array(Participant),
  you: ParticipantId,
});
export type Presence = typeof Presence.Type;

export const PresenceJson = Schema.fromJsonString(Presence);
export const CursorJson = Schema.fromJsonString(Cursor);

/** What a client says it is reading: the PRD section that is current in its window. */
export const Reading = Schema.Struct({ reading: PrdSectionId });
export type Reading = typeof Reading.Type;
export const ReadingJson = Schema.fromJsonString(Reading);

/** A frame a client sends the room: where its pointer is, or what it is reading. */
export const ClientFrameJson = Schema.fromJsonString(Schema.Union([Cursor, Reading]));

export * from "./events.ts";
export * from "./judgments.ts";
export * from "./trace.ts";
