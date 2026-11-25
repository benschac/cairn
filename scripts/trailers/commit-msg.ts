// lefthook's commit-msg hook: refuse a commit on a task's branch whose message lacks the task's trailers.
//
//   node scripts/trailers/commit-msg.ts <message file>
//
// Landing is read from the Cairn-Task trailer on a commit (see spec.status.trailer-check), so a task commit without
// it never lands. On a branch that is not a task's `branch` in .cairn/manifest.json, or with no branch checked out,
// as in a rebase, the message passes. Cairn-Session is not required.

import { Manifest } from "@cairn/contract";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Array,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Runtime,
  Schema,
  Stream,
  String,
} from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { refusal } from "./check.ts";

const MANIFEST = ".cairn/manifest.json";

// The refusal is logged once, so the runtime is told not to print it again.
class TrailersMissing extends Schema.TaggedError<TrailersMissing>()("TrailersMissing", {
  report: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return this.report;
  }
}

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

// Why git could not read the message's trailers.
class TrailersUnreadable extends Schema.TaggedError<TrailersUnreadable>()("TrailersUnreadable", {
  exitCode: Schema.Number,
}) {
  override get message() {
    return `git interpret-trailers exited ${this.exitCode}`;
  }
}

// Runs git with its stderr shown, and gives back what it printed and how it exited.
const git = (args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { stderr: "inherit" }));
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { exitCode, stdout };
    }),
  );

// The checked-out branch; none when HEAD is detached, where `git symbolic-ref` exits 1.
const currentBranch = Effect.map(
  git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
  ({ exitCode, stdout }) => (exitCode === 0 ? Option.some(String.trim(stdout)) : Option.none()),
);

// The message's trailers as git reads them, which is how landing reads them: only the last paragraph, without
// comment lines or what follows the scissors line `git commit -v` adds.
const trailersOf = (file: string) =>
  Effect.flatMap(git(["interpret-trailers", "--parse", file]), ({ exitCode, stdout }) =>
    exitCode === 0 ? Effect.succeed(stdout) : Effect.fail(new TrailersUnreadable({ exitCode })),
  );

// The task whose branch is checked out; none on any other branch or with no branch checked out.
const taskOnBranch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const branch = yield* currentBranch;
  if (Option.isNone(branch)) return Option.none();
  const manifest = yield* fs.readFileString(MANIFEST).pipe(Effect.flatMap(decodeManifest));
  return Array.findFirst(manifest.tasks, (each) => each.branch === branch.value);
});

const commitMsg = Command.make(
  "commit-msg",
  {
    file: Argument.String("message-file").pipe(
      Argument.withDescription("The commit message file git passes the hook"),
    ),
  },
  ({ file }) =>
    Effect.gen(function* () {
      const task = yield* taskOnBranch;
      const report = yield* Option.match(task, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (each) => Effect.map(trailersOf(file), (trailers) => refusal(each, trailers)),
      });
      yield* Option.match(report, {
        onNone: () => Effect.void,
        onSome: (text) => Effect.fail(new TrailersMissing({ report: text })),
      });
    }).pipe(Effect.tapErrorTag("TrailersMissing", (error) => Effect.logError(error.message))),
).pipe(
  Command.withDescription("Refuse a task branch's commit message that lacks its Cairn trailers"),
);

// Logs go to stderr so they show next to the hook's output.
const logger = Logger.layer([Logger.withConsoleError(Logger.formatSimple)]);

commitMsg.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide(Layer.mergeAll(logger, NodeServices.layer)),
  NodeRuntime.runMain,
);
