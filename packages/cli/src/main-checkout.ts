import { Context, Effect, Layer, Path, Schema, Stream, String } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Git could not say where the repository's main checkout is, or the repository has none (a bare one). */
export class NotARepository extends Schema.TaggedError<
  NotARepository,
  { readonly brand: unique symbol }
>()("NotARepository", {
  reason: Schema.String,
}) {
  override get message() {
    return `Cairn needs a git repository with a main checkout: ${this.reason}`;
  }
}

/** The main checkout of the repository, found from git's common directory, so a linked worktree reaches the same `.cairn/` as everyone else. */
export class MainCheckout extends Context.Service<
  MainCheckout,
  { readonly root: Effect.Effect<string, NotARepository> }
>()("@cairn/cli/MainCheckout") {
  /** A main checkout at a fixed directory, for tests. */
  static readonly fixed = (root: string) =>
    Layer.succeed(MainCheckout, MainCheckout.of({ root: Effect.succeed(root) }));

  /** Asks `git rev-parse --git-common-dir` from `directory`, which defaults to the working directory. */
  static readonly layer = (directory = ".") =>
    Layer.effect(
      MainCheckout,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const root = Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(
                "git",
                ["rev-parse", "--path-format=absolute", "--git-common-dir"],
                { cwd: directory },
              ),
            );
            const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout));
            yield* handle.exitCode;
            return String.trim(stdout);
          }),
        ).pipe(
          Effect.mapError((error) => new NotARepository({ reason: error.message })),
          Effect.flatMap((commonDir) =>
            path.basename(commonDir) === ".git"
              ? Effect.succeed(path.dirname(commonDir))
              : Effect.fail(new NotARepository({ reason: `${commonDir} is not a .git directory` })),
          ),
        );
        return MainCheckout.of({ root });
      }),
    );
}
