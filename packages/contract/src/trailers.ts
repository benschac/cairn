import { Array, Result, Schema, String, pipe } from "effect";

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

/** Why a commit message's trailers were refused. */
export class TrailerError extends Schema.TaggedError<
  TrailerError,
  { readonly brand: unique symbol }
>()("TrailerError", {
  detail: Schema.String,
  reason: TrailerFailure,
}) {}

export const formatTrailers = (trailers: Trailers): string =>
  pipe(
    Array.map(trailers.sections, (section) => `Cairn-Section: ${section}`),
    Array.prepend(`Cairn-Task: ${trailers.taskId}`),
    Array.append(`Cairn-Session: ${trailers.sessionId}`),
    Array.join("\n"),
  );

const TRAILER_LINE = /^Cairn-(Task|Section|Session):[ \t]*(.*?)[ \t]*$/u;

/** A `Cairn-<key>: <value>` line, or a failure for any other line. */
const readTrailer = (line: string): Result.Result<{ key: string; value: string }, void> => {
  const match = TRAILER_LINE.exec(line);
  return match === null
    ? Result.failVoid
    : Result.succeed({ key: match[1] ?? "", value: match[2] ?? "" });
};

const refuse = (reason: TrailerFailure, detail: string) => new TrailerError({ detail, reason });

/** The value of a trailer that has to appear exactly once. */
const single = (
  values: ReadonlyArray<string>,
  key: string,
  missing: TrailerFailure,
  duplicate: TrailerFailure,
): Result.Result<string, TrailerError> =>
  Array.match(values, {
    onEmpty: () => Result.fail(refuse(missing, `no Cairn-${key} trailer`)),
    onNonEmpty: ([value, ...rest]) =>
      Array.isReadonlyArrayNonEmpty(rest)
        ? Result.fail(refuse(duplicate, `more than one Cairn-${key} trailer`))
        : Result.succeed(value),
  });

const decodeTrailers = Schema.decodeUnknownResult(Trailers);

/** Reads the Cairn trailers out of a commit message. Other lines are ignored. */
export const parseTrailers = (message: string): Result.Result<Trailers, TrailerError> =>
  Result.gen(function* () {
    const found = Array.groupBy(
      Array.filterMap(String.split(message, /\r?\n/u), readTrailer),
      ({ key }) => key,
    );
    const values = (key: string) => Array.map(found[key] ?? [], ({ value }) => value);
    const taskId = yield* single(values("Task"), "Task", "missing-task", "duplicate-task");
    const sessionId = yield* single(
      values("Session"),
      "Session",
      "missing-session",
      "duplicate-session",
    );
    const sections = values("Section");
    if (!Array.isReadonlyArrayNonEmpty(sections)) {
      return yield* Result.fail(refuse("missing-section", "no Cairn-Section trailer"));
    }
    return yield* Result.mapError(decodeTrailers({ sections, sessionId, taskId }), (error) =>
      refuse("invalid", error.message),
    );
  });
