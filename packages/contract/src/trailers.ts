import { Result, Schema } from "effect";

import { SpecSectionId, TaskId } from "./ids.ts";

export const SessionId = Schema.String.check(Schema.isPattern(/^s_[a-z0-9]{6,}$/u)).pipe(
  Schema.brand("SessionId"),
);
export type SessionId = typeof SessionId.Type;

/** A full git commit sha: 40 lowercase hex characters. Short shas are not accepted. */
export const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)).pipe(
  Schema.brand("Sha"),
);
export type Sha = typeof Sha.Type;

export const Trailers = Schema.Struct({
  sections: Schema.NonEmptyArray(SpecSectionId),
  sessionId: SessionId,
  taskId: TaskId,
});
export type Trailers = typeof Trailers.Type;

export const TrailerFailure = Schema.Literals([
  "missing-task",
  "duplicate-task",
  "missing-session",
  "duplicate-session",
  "missing-section",
  "invalid",
]);
export type TrailerFailure = typeof TrailerFailure.Type;

export const TrailerError = Schema.Struct({
  detail: Schema.String,
  reason: TrailerFailure,
});
export type TrailerError = typeof TrailerError.Type;

export const formatTrailers = (trailers: Trailers): string =>
  [
    `Cairn-Task: ${trailers.taskId}`,
    ...trailers.sections.map((section) => `Cairn-Section: ${section}`),
    `Cairn-Session: ${trailers.sessionId}`,
  ].join("\n");

const TRAILER_LINE = /^Cairn-(Task|Section|Session):[ \t]*(.*?)[ \t]*$/u;

const decodeTrailers = Schema.decodeUnknownResult(Trailers);

/** Reads the Cairn trailers out of a commit message. Other lines are ignored. */
export const parseTrailers = (message: string): Result.Result<Trailers, TrailerError> => {
  const tasks: Array<string> = [];
  const sections: Array<string> = [];
  const sessions: Array<string> = [];
  for (const line of message.split(/\r?\n/u)) {
    const match = TRAILER_LINE.exec(line);
    if (match === null) continue;
    const [, key, value = ""] = match;
    (key === "Task" ? tasks : key === "Section" ? sections : sessions).push(value);
  }
  const fail = (reason: TrailerFailure, detail: string) =>
    Result.fail<TrailerError>({ detail, reason });
  if (tasks.length === 0) return fail("missing-task", "no Cairn-Task trailer");
  if (tasks.length > 1) return fail("duplicate-task", "more than one Cairn-Task trailer");
  if (sessions.length === 0) return fail("missing-session", "no Cairn-Session trailer");
  if (sessions.length > 1) return fail("duplicate-session", "more than one Cairn-Session trailer");
  if (sections.length === 0) return fail("missing-section", "no Cairn-Section trailer");
  return Result.mapError(
    decodeTrailers({ sections, sessionId: sessions[0], taskId: tasks[0] }),
    (error) => ({ detail: String(error), reason: "invalid" as const }),
  );
};
