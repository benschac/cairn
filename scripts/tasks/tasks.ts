// Say which of the manifest's tasks can be started, and show one task with what an agent needs to build it.
//
//   pnpm tasks          every unfinished task: drifted, active, claimed, ready or blocked
//   pnpm tasks <id>     one task: what it waits on, its files and its spec sections as line ranges of the spec
//
// The manifest alone does not say what is free. This joins .cairn/manifest.json with the Cairn-Task trailers on
// origin/main, the open and merged pull requests, the git worktrees and the cairn/work channel of the board, so
// nobody has to read the manifest or the spec index whole. A source that cannot be reached is named in a note and
// left out; the report still prints.

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Manifest, SpecIndexJson } from "@cairn/contract";
import {
  Array,
  Console,
  DateTime,
  Effect,
  FileSystem,
  HashSet,
  Layer,
  Logger,
  Option,
  Path,
  Ref,
  Runtime,
  Schema,
  Stream,
  String,
} from "effect";
import { Argument, Command } from "effect/cli";
import type { DecisionModel } from "effect/ai";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { environmentLayer } from "../../packages/cli/src/environment.ts";
import { liveDecisionModel } from "../../packages/cli/src/models.ts";
import {
  BoardRead,
  classify,
  type Decided,
  parseWorktrees,
  Pull,
  PULL_FIELDS,
  renderOverview,
  renderTask,
  toJudge,
  trailerTasks,
} from "./report.ts";
import { judgeThreads, loadConfig } from "./reply-questions.ts";

const TRUNK = "origin/main";
const CHANNEL = "cairn/work";
const MANIFEST = ".cairn/manifest.json";
const CONFIG = ".cairn/config.json";
const SPEC_INDEX = ".cairn/spec.json";
const LIST_LIMIT = 300;
const THREAD_LIMIT = 200;

// Each expected failure logs its own message once (see the command below), so the runtime is told not to print it again.
class UnknownTask extends Schema.TaggedError<UnknownTask>()("UnknownTask", {
  id: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `${this.id} is not a task in ${MANIFEST}`;
  }
}

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {
  override get message() {
    const line = Array.join(Array.prepend(this.args, this.command), " ");
    return `${line} exited with ${this.exitCode}${String.isNonEmpty(this.stderr) ? `: ${this.stderr}` : ""}`;
  }
}

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const decodeSpecIndex = Schema.decodeUnknownEffect(SpecIndexJson);
const decodePulls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Pull)));
const decodeBoard = Schema.decodeUnknownEffect(Schema.fromJsonString(BoardRead));

const tasks = Effect.fn("tasks")(function* ({ task }: { task: Option.Option<string> }) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* path.fromFileUrl(new URL("../../", import.meta.url));

  // Runs a command in the repository and returns its trimmed stdout; a non-zero exit fails with its stderr.
  const sh = (command: string, args: string[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: repo }));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return yield* new CommandFailed({ command, args, exitCode, stderr: String.trim(stderr) });
        }
        return String.trim(stdout);
      }),
    );
  // The exit code of a git command that answers with it: 0 for yes, anything else for no.
  const holds = (args: string[]) =>
    spawner.exitCode(ChildProcess.make("git", args, { cwd: repo })).pipe(
      Effect.map((exitCode) => exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

  const notes = yield* Ref.make<ReadonlyArray<string>>([]);
  const note = (text: string) => Ref.update(notes, Array.append(text));
  // Notes that a source could not be read, with the first line of why.
  const leftOut = (source: string, error: { readonly message: string }) =>
    note(`${source} left out: ${Array.headNonEmpty(String.split(error.message, "\n"))}`);
  // Leaves a source out of the report, with a note, when it cannot be read.
  const orLeftOut =
    (source: string) =>
    <A, E extends { readonly message: string }, R>(
      read: Effect.Effect<ReadonlyArray<A>, E, R>,
    ): Effect.Effect<ReadonlyArray<A>, never, R> =>
      read.pipe(Effect.catch((error) => Effect.as(leftOut(source, error), Array.empty<A>())));
  // Says so when a listing came back full: what lies past its limit was not read, so a claim there is not seen.
  const noteIfFull =
    (what: string, limit: number) =>
    <A, E, R>(read: Effect.Effect<ReadonlyArray<A>, E, R>) =>
      Effect.tap(read, (items) =>
        items.length < limit
          ? Effect.void
          : note(`only the latest ${limit} ${what} were read; an older claim may be missing`),
      );
  const pulls = (state: string) =>
    sh("gh", [
      "pr",
      "list",
      "--state",
      state,
      "--limit",
      `${LIST_LIMIT}`,
      "--json",
      PULL_FIELDS,
    ]).pipe(
      Effect.flatMap(decodePulls),
      noteIfFull(`${state} pull requests`, LIST_LIMIT),
      orLeftOut(`${state} pull requests`),
    );

  const manifest = yield* fs
    .readFileString(path.join(repo, MANIFEST))
    .pipe(Effect.flatMap(decodeManifest));

  yield* sh("git", ["fetch", "--quiet", "origin"]).pipe(
    Effect.asVoid,
    Effect.catch((error) => leftOut("the fetch of origin", error)),
  );
  if (!(yield* holds(["diff", "--quiet", TRUNK, "--", MANIFEST]))) {
    yield* note(`this checkout's ${MANIFEST} differs from ${TRUNK}`);
  }

  const [trailers, open, merged, worktrees, threads] = yield* Effect.all(
    [
      sh("git", ["log", TRUNK, "--format=%B"]).pipe(
        Effect.map(trailerTasks),
        orLeftOut(`the trailers on ${TRUNK}`),
      ),
      pulls("open"),
      pulls("merged"),
      sh("git", ["worktree", "list", "--porcelain"]).pipe(
        Effect.map(parseWorktrees),
        orLeftOut("the worktrees"),
      ),
      sh("vercel", ["board", "read", CHANNEL, "--json", "--limit", `${THREAD_LIMIT}`]).pipe(
        Effect.flatMap(decodeBoard),
        Effect.map((board) => board.threads),
        noteIfFull(`${CHANNEL} board threads`, THREAD_LIMIT),
        orLeftOut(`the ${CHANNEL} board channel`),
      ),
    ],
    { concurrency: "unbounded" },
  );

  // A stack's pull request is merged into the branch below it, so "merged" alone does not put a task on main.
  const branches = HashSet.fromIterable(Array.map(manifest.tasks, (each) => each.branch));
  const onTrunk = yield* Effect.filter(
    Array.filter(merged, (pull) => HashSet.has(branches, pull.headRefName)),
    (pull) => holds(["merge-base", "--is-ancestor", pull.headRefOid, TRUNK]),
    { concurrency: 4 },
  );

  const now = yield* DateTime.now;
  const given = { trailers, merged: onTrunk, open, worktrees, threads, now };
  // The judge's settings are .cairn/config.json's, and building its layer reads its key or gateway token from the
  // environment: without them the layer fails, and the regex of isOpen decides every thread.
  const judge: Layer.Layer<DecisionModel.DecisionModel, { readonly message: string }> =
    Layer.unwrap(
      loadConfig(fs.readFileString(path.join(repo, CONFIG))).pipe(Effect.map(liveDecisionModel)),
    );
  const asked = toJudge(classify(manifest, given), threads);
  const { decided, unavailable } = yield* Array.match(asked, {
    onEmpty: () =>
      Effect.succeed({ decided: Array.empty<Decided>(), unavailable: Option.none<string>() }),
    // .env is a fallback to the shell environment for the key and the gateway token, as for the cairn CLI.
    onNonEmpty: (some) => judgeThreads(some, judge, environmentLayer),
  });
  yield* Option.match(unavailable, {
    onNone: () => Effect.void,
    onSome: (why) =>
      note(`no judge for the board threads, so the Stopping and Landed convention decides: ${why}`),
  });
  const evidence = { ...given, decided };
  const rows = classify(manifest, evidence);

  const report = yield* Option.match(task, {
    onNone: () => Effect.succeed(renderOverview(manifest, rows, evidence)),
    onSome: Effect.fnUntraced(function* (id) {
      const row = yield* Effect.fromOption(
        Array.findFirst(rows, (each) => each.task.id === id),
      ).pipe(Effect.mapError(() => new UnknownTask({ id })));
      const index = yield* fs
        .readFileString(path.join(repo, SPEC_INDEX))
        .pipe(Effect.flatMap(decodeSpecIndex));
      const spec = yield* fs.readFileString(path.join(repo, index.source));
      return renderTask(row, rows, index, String.split(String.trimEnd(spec), "\n").length);
    }),
  });
  const warnings = yield* Ref.get(notes);
  yield* Effect.forEach(warnings, (text) => Effect.logWarning(text), { discard: true });
  return yield* Console.log(report);
});

const command = Command.make(
  "tasks",
  {
    task: Argument.String("task").pipe(
      Argument.withDescription("A task id such as t31, to show that task alone"),
      Argument.optional,
    ),
  },
  (input) =>
    tasks(input).pipe(
      // The expected failure logs its own message once; the runtime prints anything else.
      Effect.tapErrorTag("UnknownTask", (error) => Effect.logError(error.message)),
    ),
).pipe(
  Command.withDescription(
    "Show which tasks of the manifest are claimed, ready or blocked, or one task in full",
  ),
);

// Logs go to stderr so stdout holds only the report.
const logger = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(logger, NodeServices.layer)),
  NodeRuntime.runMain,
);
