// Gate pushes on `pnpm check`, so a stack is checked once at its top instead of on every commit.
//
//   node scripts/gate/gate.ts check      run the full check (pnpm check); when it passes on a clean tree,
//                                         record HEAD as checked
//   node scripts/gate/gate.ts pre-push   lefthook's pre-push hook: refuse a push that sends a commit no
//                                         checked commit contains
//
// A check that passes at the top of a stack covers every branch below it, so `gt submit --stack` pushes them
// all without running the check again. A rebase rewrites the commits, so the check has to run again after it.
// The record does not prove each branch below the top passes on its own: CI checks every pull request, and
// `pnpm land` refuses one whose `check` job has not passed.

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Array,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Path,
  Runtime,
  Schema,
  Stdio,
  Stream,
  String,
} from "effect";
import { Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { appendRecord, pushedCommits, RECORD_FILE, recordedCommits } from "./checked.ts";

// Each expected failure logs its own message once (see the commands below), so the runtime is told not to print it again.
class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  exitCode: Schema.Int,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `The check failed (exit ${this.exitCode}); nothing was recorded`;
  }
}

class PushUnchecked extends Schema.TaggedError<PushUnchecked>()("PushUnchecked", {
  commits: Schema.Array(Schema.String),
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    const listed = Array.join(
      Array.map(this.commits, (sha) => String.takeLeft(sha, 7)),
      ", ",
    );
    return `Push refused: no commit that passed \`pnpm check\` contains ${listed}. Check out the top of the stack, commit everything, run \`pnpm check\` and push again.`;
  }
}

class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.Int,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `git ${Array.join(this.args, " ")} exited with ${this.exitCode}`;
  }
}

// Runs git in the current directory and returns its trimmed stdout; a non-zero exit fails.
const git = Effect.fnUntraced(function* (args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [stdout, exitCode] = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { stderr: "inherit" }));
      return yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" },
      );
    }),
  );
  if (exitCode !== 0) return yield* new GitFailed({ args, exitCode });
  return String.trim(stdout);
});

const recordPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const common = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return path.join(common, RECORD_FILE);
});

const readRecord = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* recordPath;
  const present = yield* fs.exists(file);
  return { file, record: present ? yield* fs.readFileString(file) : "" };
});

// HEAD and whether the tree has no uncommitted or untracked changes.
const snapshot = Effect.all({
  head: git(["rev-parse", "HEAD"]),
  clean: Effect.map(git(["status", "--porcelain"]), String.isEmpty),
});

const check = Command.make("check", {}, () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const before = yield* snapshot;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make("pnpm", ["run", "--silent", "check:tasks"], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (exitCode !== 0) return yield* new CheckFailed({ exitCode });
    const after = yield* snapshot;
    const short = String.takeLeft(after.head, 7);
    if (!(before.clean && after.clean && before.head === after.head)) {
      return yield* Effect.logWarning(
        `Passed, but ${short} was not recorded as checked: the tree had uncommitted changes or HEAD moved. Commit everything and run pnpm check again before pushing.`,
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const { file, record } = yield* readRecord;
    yield* fs.writeFileString(file, appendRecord(record, after.head));
    return yield* Effect.logInfo(
      `Recorded ${short} as checked: it and every commit below it may be pushed.`,
    );
  }).pipe(
    // Each expected failure logs its own message once; the runtime prints anything else.
    Effect.tapErrorTag(["CheckFailed", "GitFailed"], (error) => Effect.logError(error.message)),
  ),
).pipe(Command.withDescription("Run pnpm check and record HEAD as checked when it passes"));

const prePush = Command.make("pre-push", {}, () =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const input = yield* Stream.mkString(Stream.decodeText(stdio.stdin));
    const pushed = pushedCommits(input);
    const checked = recordedCommits((yield* readRecord).record);
    // A pushed commit is covered when nothing in its history lies outside every checked commit's history.
    const unchecked = yield* Effect.filter(
      pushed,
      (sha) =>
        Effect.map(
          git(Array.appendAll(["rev-list", "--ignore-missing", "-n", "1", sha, "--not"], checked)),
          String.isNonEmpty,
        ),
      { concurrency: 4 },
    );
    if (Array.isReadonlyArrayNonEmpty(unchecked)) {
      return yield* new PushUnchecked({ commits: unchecked });
    }
    return yield* Effect.logInfo(
      "Push allowed: a commit that passed pnpm check contains every pushed commit.",
    );
  }).pipe(
    Effect.tapErrorTag(["PushUnchecked", "GitFailed"], (error) => Effect.logError(error.message)),
  ),
).pipe(Command.withDescription("Refuse a push that sends a commit no checked commit contains"));

// Logs go to stderr so they show next to the hook's output.
const logger = Logger.layer([Logger.withConsoleError(Logger.formatSimple)]);

Command.make("gate").pipe(
  Command.withSubcommands([check, prePush]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(Layer.mergeAll(logger, NodeServices.layer)),
  NodeRuntime.runMain,
);
