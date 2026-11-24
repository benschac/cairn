import { Manifest, SessionId, Sha, SpecSectionId, TaskId } from "@cairn/contract";
import { Array, Effect, HashSet, Layer, Option, Schema, Stream, String } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Git, GitError, assemble, rangesOf } from "./git.ts";
import type { Logged } from "./git.ts";

/** Starts each commit's record, so a subject or a file name cannot split one. */
const RECORD = "\x1e";
const FIELD = "\x1f";

/**
 * The sha, the parents, the subject and the three Cairn trailers, each trailer's values one per
 * line, then a separator: `--name-only` prints the changed files after it.
 */
const LOG_FORMAT = `--format=%x1e${Array.join(
  [
    "%H",
    "%P",
    "%s",
    "%(trailers:key=Cairn-Task,valueonly)",
    "%(trailers:key=Cairn-Section,valueonly)",
    "%(trailers:key=Cairn-Session,valueonly)",
    "",
  ],
  "%x1f",
)}`;

const linesOf = (text: string): ReadonlyArray<string> =>
  Array.filter(Array.map(String.split(text, "\n"), String.trim), String.isNonEmpty);

/** The first value that is a valid id, or `null`: a malformed trailer reads as a missing one. */
const firstOf =
  <A>(is: (value: unknown) => value is A) =>
  (values: ReadonlyArray<string>): A | null =>
    Option.getOrNull(Array.findFirst(values, is));

const LogRecord = Schema.Tuple([
  Sha,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.String,
]);

const decodeRecord = (record: string) =>
  Schema.decodeUnknownEffect(LogRecord)(String.split(record, FIELD)).pipe(
    Effect.map(([sha, parents, subject, tasks, sections, sessions, files]): Logged => ({
      files: linesOf(files),
      parents: Array.map(Array.filter(String.split(parents, " "), String.isNonEmpty), (parent) =>
        Sha.make(parent),
      ),
      sections: Array.filter(linesOf(sections), Schema.is(SpecSectionId)),
      session: firstOf(Schema.is(SessionId))(linesOf(sessions)),
      sha,
      subject,
      taskId: firstOf(Schema.is(TaskId))(linesOf(tasks)),
    })),
  );

/** `Git` read by running git in `directory`, which defaults to the working directory. */
export const layer = (directory = ".") =>
  Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const run = (args: ReadonlyArray<string>) =>
        Effect.scoped(
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
              : yield* new GitError({ args, detail: String.trim(stderr), exitCode });
          }),
        ).pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(new GitError({ args, detail: error.message, exitCode: null })),
          ),
        );

      const read = (revisions: ReadonlyArray<string>) => {
        const args = Array.flatten([
          ["log", "--no-renames", "--name-only", LOG_FORMAT],
          revisions,
          ["--"],
        ]);
        return run(args).pipe(
          Effect.flatMap((stdout) =>
            Effect.forEach(Array.drop(String.split(stdout, RECORD), 1), (record) =>
              decodeRecord(record).pipe(
                Effect.mapError(
                  (error) => new GitError({ args, detail: error.message, exitCode: null }),
                ),
              ),
            ),
          ),
        );
      };

      const log = Effect.fn("Git.log")(function* (manifest: Manifest) {
        const base = manifest.baseBranch;
        const [heads, reachable, fromBase] = yield* Effect.all(
          [
            run(["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"]),
            run(["rev-list", base, "--"]),
            read(["-E", "--grep=^Cairn-Task:", base]),
          ],
          { concurrency: "unbounded" },
        );
        const branches = HashSet.fromIterable(linesOf(heads));
        const fromBranches = yield* Effect.forEach(
          rangesOf(manifest, (branch) => HashSet.has(branches, branch)),
          ({ branch, from }) =>
            Effect.map(read([`${from}..${branch}`]), (commits) => ({ branch, commits })),
          { concurrency: 4 },
        );
        return assemble(
          HashSet.fromIterable(Array.map(linesOf(reachable), (sha) => Sha.make(sha))),
          fromBranches,
          fromBase,
        );
      });

      return Git.of({ log });
    }),
  );
