import { Array, Schema } from "effect";

import { TaskId } from "./ids.ts";
import { SessionId } from "./trailers.ts";

/** A prompt the person gave the agent. `id` is the log line's uuid. */
export const PromptTurn = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  id: Schema.String,
  kind: Schema.Literal("prompt"),
  text: Schema.String,
});
export type PromptTurn = typeof PromptTurn.Type;

/** Text the agent wrote back. */
export const ReplyTurn = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  id: Schema.String,
  kind: Schema.Literal("reply"),
  text: Schema.String,
});
export type ReplyTurn = typeof ReplyTurn.Type;

/** One edit to a file: the lines it wrote and the lines it removed, without the diff markers. */
export const FileEdit = Schema.Struct({
  added: Schema.Array(Schema.String),
  path: Schema.String,
  removed: Schema.Array(Schema.String),
});
export type FileEdit = typeof FileEdit.Type;

/** A tool call and its result. `id` is the call's id, which its result repeats. */
export const ToolTurn = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  edits: Schema.Array(FileEdit),
  failed: Schema.Boolean,
  id: Schema.String,
  input: Schema.String,
  kind: Schema.Literal("tool"),
  name: Schema.String,
  output: Schema.String,
  target: Schema.NullOr(Schema.String),
});
export type ToolTurn = typeof ToolTurn.Type;

export const Turn = Schema.Union([PromptTurn, ReplyTurn, ToolTurn]);
export type Turn = typeof Turn.Type;

/** Something a person or reviewer attached to a session. */
export const SessionNote = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  author: Schema.String,
  body: Schema.String,
  kind: Schema.Literals(["note", "review", "annotation"]),
});
export type SessionNote = typeof SessionNote.Type;

const uniqueTurnIds = Schema.makeFilter<{ readonly turns: ReadonlyArray<Turn> }>(({ turns }) => {
  const ids = Array.map(turns, ({ id }) => id);
  return Array.dedupe(ids).length === ids.length
    ? undefined
    : "turn ids must be unique within a session";
});

/**
 * A session as Cairn reads it: what `GET /api/sessions/:id` sends and the
 * session pane draws. Turn ids are unique; a duplicate is refused.
 */
export const Session = Schema.Struct({
  format: Schema.Literals(["claude-code", "unknown"]),
  id: SessionId,
  notes: Schema.Array(SessionNote),
  redactions: Schema.Record(Schema.String, Schema.Int),
  skipped: Schema.Int,
  taskId: TaskId,
  turns: Schema.Array(Turn),
  version: Schema.Literal(1),
}).pipe(Schema.check(uniqueTurnIds));
export type Session = typeof Session.Type;
