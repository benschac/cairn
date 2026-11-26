import { Session, SessionId, Sha, Trace } from "@cairn/contract";
import { sessionOf, traceOf } from "@cairn/core";
import {
  Array,
  Context,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  Schema,
  Stream,
  String,
} from "effect";
import { HttpRouter, HttpServerRespondable, HttpServerResponse } from "effect/http";
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

/**
 * Git failed for a reason other than a revision it does not have: a `500` with git's message, which
 * the server reports, since the route did not expect it.
 */
export class GitFailed
  extends Schema.TaggedError<GitFailed, { readonly brand: unique symbol }>()("GitFailed", {
    exitCode: Schema.Int,
    stderr: Schema.String,
  })
  implements HttpServerRespondable.Respondable
{
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.text(this.stderr, { status: 500 }));
  }
}

/**
 * Git does not have a revision the route was asked for: a `404` with git's message. The route owes
 * that answer, so the server does not report it.
 */
export class RevisionUnknown
  extends Schema.TaggedError<RevisionUnknown, { readonly brand: unique symbol }>()(
    "RevisionUnknown",
    { stderr: Schema.String },
  )
  implements HttpServerRespondable.Respondable
{
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.text(this.stderr, { status: 404 }));
  }

  override readonly [ErrorReporter.ignore] = true;
}

/**
 * A path parameter that does not decode: a `400` that says what did not decode. The router's own
 * `400` for a `SchemaError` is still reported, so a route decodes its parameters through `paramsOf`.
 */
export class MalformedParams
  extends Schema.TaggedError<MalformedParams, { readonly brand: unique symbol }>()(
    "MalformedParams",
    { issue: Schema.String },
  )
  implements HttpServerRespondable.Respondable
{
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.text(this.issue, { status: 400 }));
  }

  override readonly [ErrorReporter.ignore] = true;
}

/** The route's parameters decoded through `schema`, failing with `MalformedParams`. */
const paramsOf = <
  A,
  I extends Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
  RD,
>(
  schema: Schema.ConstraintCodec<A, I, RD, unknown>,
) =>
  HttpRouter.schemaParams(schema).pipe(
    Effect.mapError((error) => new MalformedParams({ issue: error.message })),
  );

/** How git words a revision it does not have. */
const UNKNOWN_REVISION = /bad object|bad revision|unknown revision|not a valid object name/iu;

/**
 * Runs git with an argument list, never a shell, and returns its stdout. A non-zero exit fails with
 * git's stderr: `RevisionUnknown` when git does not have a revision, `GitFailed` otherwise.
 */
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
      if (exitCode === 0) {
        return stdout;
      }
      const message = String.trim(stderr);
      return Option.isSome(String.match(UNKNOWN_REVISION)(message))
        ? yield* new RevisionUnknown({ stderr: message })
        : yield* new GitFailed({ exitCode, stderr: message });
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

/**
 * `GET /api/commits/:sha` (see `spec.patch-routes`). The route only fails, and each failure renders
 * itself: a SHA that does not decode is `MalformedParams`, git's are `RevisionUnknown` and `GitFailed`.
 */
export const CommitRoute = HttpRouter.add("GET", "/api/commits/:sha", () =>
  paramsOf(Commit).pipe(
    Effect.flatMap(({ sha }) => git(["show", "--patch", sha])),
    Effect.map(patch),
  ),
);

/** `GET /api/diffs/:base/:head` (see `spec.patch-routes`), failing as `CommitRoute` does. */
export const DiffRoute = HttpRouter.add("GET", "/api/diffs/:base/:head", () =>
  paramsOf(Range).pipe(
    Effect.flatMap(({ base, head }) => git(["diff", "--patch", base, head])),
    Effect.map(patch),
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
 * A request whose `If-None-Match` names that tag gets `304` without the Trace being built. A
 * `.cairn/` file or git that fails is a `500` the server reports.
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
  }),
);

const SessionParams = Schema.Struct({ id: SessionId });

const encodeSession = HttpServerResponse.schemaJson(Session);

/**
 * The stored session read by `sessionOf`. Notes are not stored yet (see `spec.sessions.trace-store`),
 * so they are empty. A stored row that does not decode is a defect here: left a `SchemaError`, it
 * would render as the `400` of a malformed request.
 */
const sessionResponse = Effect.fn("sessionResponse")(function* (id: SessionId) {
  const store = yield* TraceStore;
  const { log, redactions, taskId } = yield* store
    .get(id)
    .pipe(Effect.catchTag("SchemaError", (error) => Effect.die(error)));
  return yield* encodeSession(sessionOf(log, { id, notes: [], redactions, taskId }));
});

/**
 * `GET /api/sessions/:id` (see `spec.server`): the `Session` as JSON. An id that is not a
 * `SessionId` is `MalformedParams` and never reaches the store, `SessionNotFound` renders its
 * `404`, and a store that cannot answer is a `500` the server reports.
 */
export const SessionRoute = HttpRouter.add("GET", "/api/sessions/:id", () =>
  paramsOf(SessionParams).pipe(Effect.flatMap(({ id }) => sessionResponse(id))),
);

export const ApiRoutes = Layer.mergeAll(CommitRoute, DiffRoute, TraceRoute, SessionRoute);
