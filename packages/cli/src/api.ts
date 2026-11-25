import { Session, SessionId, Sha, Trace } from "@cairn/contract";
import { sessionOf, traceOf } from "@cairn/core";
import { Array, Context, Effect, Layer, Option, Schema, Stream, String } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { inputsHashOf, loadTraceInput } from "./load-trace.ts";
import { TraceStore } from "./trace-store.ts";

/** The repository the patch routes read. A directory other than the server's own lets a test use a temporary repository. */
export class Repository extends Context.Service<Repository, { readonly directory: string }>()(
  "@cairn/cli/Repository",
) {
  /** The repository in `directory`, which defaults to the server's working directory. */
  static readonly layer = (directory = ".") =>
    Layer.succeed(Repository, Repository.of({ directory }));
}

class GitFailed extends Schema.TaggedError<GitFailed, { readonly brand: unique symbol }>()(
  "GitFailed",
  {
    exitCode: Schema.Int,
    stderr: Schema.String,
  },
) {}

/** How git words a revision it does not have. */
const UNKNOWN_REVISION = /bad object|bad revision|unknown revision|not a valid object name/iu;

/** Runs git with an argument list, never a shell, and returns its stdout. A non-zero exit fails with git's stderr. */
const git = Effect.fn("git")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { directory } = yield* Repository;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: directory }));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return exitCode === 0
        ? stdout
        : yield* new GitFailed({ exitCode, stderr: String.trim(stderr) });
    }),
  );
});

const Commit = Schema.Struct({ sha: Sha });
const Range = Schema.Struct({ base: Sha, head: Sha });

/** A patch for a pair of SHAs never changes, so it is cached for good. */
const patch = (body: string) =>
  HttpServerResponse.text(body, {
    headers: { "cache-control": "max-age=31536000, immutable" },
  });

const plain = (status: number, body: string) => HttpServerResponse.text(body, { status });

/** Turns a failed read into the status the route owes: a bad SHA is 400, one git lacks is 404, the rest 500. */
const refuse = <R>(
  read: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    GitFailed | Schema.SchemaError | PlatformError,
    R
  >,
) =>
  read.pipe(
    Effect.catchTags({
      GitFailed: (failure) =>
        Effect.succeed(
          Option.isSome(String.match(UNKNOWN_REVISION)(failure.stderr))
            ? plain(404, failure.stderr)
            : plain(500, failure.stderr),
        ),
      SchemaError: (failure) => Effect.succeed(plain(400, failure.message)),
      PlatformError: (failure) => Effect.succeed(plain(500, failure.message)),
    }),
  );

export const CommitRoute = HttpRouter.add("GET", "/api/commits/:sha", () =>
  refuse(
    HttpRouter.schemaParams(Commit).pipe(
      Effect.flatMap(({ sha }) => git(["show", "--patch", sha])),
      Effect.map(patch),
    ),
  ),
);

export const DiffRoute = HttpRouter.add("GET", "/api/diffs/:base/:head", () =>
  refuse(
    HttpRouter.schemaParams(Range).pipe(
      Effect.flatMap(({ base, head }) => git(["diff", "--patch", base, head])),
      Effect.map(patch),
    ),
  ),
);

/** Whether an `If-None-Match` header names `etag`: `*`, or a comma-separated list of tags, weak or strong. */
const matches = (header: string, etag: string): boolean =>
  Array.some(
    Array.map(String.split(",")(header), (tag) =>
      String.trim(String.replace(/^W\//u, "")(String.trim(tag))),
    ),
    (tag) => tag === "*" || tag === etag,
  );

const encodeTrace = HttpServerResponse.schemaJson(Trace);

/**
 * `GET /api/trace` (see `spec.server`): the Trace as JSON with an `ETag` from a hash of its inputs.
 * A request whose `If-None-Match` names that tag gets `304` without the Trace being built.
 */
export const TraceRoute = HttpRouter.add("GET", "/api/trace", (request) =>
  Effect.gen(function* () {
    const input = yield* loadTraceInput;
    const etag = `"${inputsHashOf(input)}"`;
    const headers = { "cache-control": "no-cache", etag };
    const fresh = Option.exists(
      Option.fromUndefinedOr(request.headers["if-none-match"]),
      (header) => matches(header, etag),
    );
    return fresh
      ? HttpServerResponse.empty({ headers, status: 304 })
      : yield* encodeTrace(traceOf(input), { headers });
  }).pipe(Effect.catch((failure) => Effect.succeed(plain(500, failure.message)))),
);

const SessionParams = Schema.Struct({ id: SessionId });

const encodeSession = HttpServerResponse.schemaJson(Session);

/** The stored session read by `sessionOf`. Notes are not stored yet (see `spec.sessions.trace-store`), so they are empty. */
const sessionResponse = Effect.fn("sessionResponse")(function* (id: SessionId) {
  const store = yield* TraceStore;
  const { log, redactions, taskId } = yield* store.get(id);
  return yield* encodeSession(sessionOf(log, { id, notes: [], redactions, taskId }));
});

/**
 * `GET /api/sessions/:id` (see `spec.server`): the `Session` as JSON. An id that is not a
 * `SessionId` is `400` and never reaches the store, one the store does not hold is `404`, and a
 * store that cannot answer is `500`.
 */
export const SessionRoute = HttpRouter.add("GET", "/api/sessions/:id", () =>
  HttpRouter.schemaParams(SessionParams).pipe(
    Effect.matchEffect({
      onFailure: (failure) => Effect.succeed(plain(400, failure.message)),
      onSuccess: ({ id }) =>
        sessionResponse(id).pipe(
          Effect.catchTag("SessionNotFound", (failure) =>
            Effect.succeed(plain(404, failure.message)),
          ),
          Effect.catch((failure) => Effect.succeed(plain(500, failure.message))),
        ),
    }),
  ),
);

export const ApiRoutes = Layer.mergeAll(CommitRoute, DiffRoute, TraceRoute, SessionRoute);
