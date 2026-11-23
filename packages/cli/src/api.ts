import { Sha } from "@cairn/contract";
import { Context, Effect, Layer, Option, Schema, Stream, String } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

export const ApiRoutes = Layer.mergeAll(CommitRoute, DiffRoute);
