// Regenerate apps/viewer/src/demo-trace.json from the repo's .cairn files, so a plan change does not need it synced by hand.
//
//   pnpm demo-trace            write the file
//   pnpm demo-trace --check    write nothing; exit non-zero naming the first difference when the file is stale
//
// The Trace is built by `traceOf` from the PRD, the spec, the manifest, the spec index and the commits the manifest
// records. The manifest holds each task's progress, not its history, so the events are synthesized from it. A done or
// landed task gets `running` then `done` (a gated one passes through `blocked_on_human` and a human approval), stamped
// with the task's time in `events.jsonl`, else its last commit's time, else the latest commit of any task. The
// `running` event names the model only for a task with a recorded session, so the viewer shows the rest as planned.
// A landed task's commits count as reached by the base branch.

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Event, EventJson, Manifest, SpecIndexJson, Trace, defaultConfig } from "@cairn/contract";
import { GitCommit, PRD_PATH, SPEC_PATH, rollupOf, traceOf } from "@cairn/core";
import {
  Array,
  Console,
  Effect,
  FileSystem,
  Formatter,
  Layer,
  Logger,
  Option,
  Path,
  Record,
  Runtime,
  Schema,
  Stream,
  String,
} from "effect";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { replaceFile } from "../../packages/cli/src/atomic-write.ts";
import { eventsOf, firstDifference, latest, parseShown, SHOW_FORMAT } from "./plan.ts";

const OUTPUT = "apps/viewer/src/demo-trace.json";
const APPROVER = "human:benjamin";

class Stale extends Schema.TaggedError<Stale>()("Stale", { difference: Schema.String }) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `${OUTPUT} is stale (${this.difference}); run pnpm demo-trace`;
  }
}

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `${this.command} exited with ${this.exitCode}: ${this.stderr}`;
  }
}

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const decodeIndex = Schema.decodeUnknownEffect(SpecIndexJson);
const encodeTrace = Schema.encodeEffect(Trace);
const decodeRecorded = Schema.decodeUnknownEffect(EventJson);
const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(Event));
const decodeCommits = Schema.decodeUnknownEffect(Schema.Array(GitCommit));

const build = Effect.fn("demo-trace.build")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const repo = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const read = (file: string) => fs.readFileString(path.join(repo, file));

  const [prd, spec, manifestText, indexText, recordedText] = yield* Effect.all(
    [
      read(PRD_PATH),
      read(SPEC_PATH),
      read(".cairn/manifest.json"),
      read(".cairn/spec.json"),
      read(".cairn/events.jsonl"),
    ],
    { concurrency: "unbounded" },
  );
  const recorded = yield* Effect.forEach(
    Array.filter(String.split(recordedText, "\n"), String.isNonEmpty),
    (line) => decodeRecorded(line),
  );
  const recordedAt = Record.fromEntries(Array.map(recorded, ({ taskId, ts }) => [taskId, ts]));
  const manifest = yield* decodeManifest(manifestText);
  const index = yield* decodeIndex(indexText);

  const shas = Array.flatMap(manifest.tasks, (task) => task.commits);
  // Runs a command in the repository, feeding it `stdin`, and returns its stdout; a non-zero exit fails with its stderr.
  const sh = (
    command: string,
    args: ReadonlyArray<string>,
    stdin: Stream.Stream<Uint8Array> | "ignore",
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: repo, stdin }));
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
          : yield* new CommandFailed({ command, exitCode, stderr: String.trim(stderr) });
      }),
    );
  const output = yield* sh(
    "git",
    Array.appendAll(["show", "--no-walk=unsorted", "--name-only", `--format=${SHOW_FORMAT}`], shas),
    "ignore",
  );
  const shown = Record.fromIterableBy(parseShown(output), ({ sha }) => sha);

  const everyTime = Array.map(Record.values(shown), ({ ts }) => ts);
  const fallback = yield* Effect.fromOption(Array.head(everyTime)).pipe(Effect.orDie);
  const commits = yield* decodeCommits(
    Array.flatMap(manifest.tasks, (task) =>
      Array.getSomes(
        Array.map(task.commits, (sha) =>
          Option.map(Record.get(shown, sha), ({ ts: _ts, ...commit }) => ({
            ...commit,
            branch: null,
            onBase: task.status === "landed",
            sections: task.specSections,
            session: Option.getOrNull(Array.head(task.sessions)),
            taskId: task.id,
          })),
        ),
      ),
    ),
  );
  const newest = latest(everyTime, fallback);
  const events = Array.flatMap(manifest.tasks, (task) =>
    eventsOf(
      task,
      task.humanGate.required,
      APPROVER,
      Option.getOrElse(Record.get(recordedAt, task.id), () =>
        latest(
          Array.getSomes(
            Array.map(task.commits, (sha) => Option.map(Record.get(shown, sha), ({ ts }) => ts)),
          ),
          newest,
        ),
      ),
    ),
  );

  const trace = traceOf({
    commits,
    config: defaultConfig,
    events: yield* decodeEvents(events),
    judgments: [],
    manifest,
    prd,
    rollup: rollupOf,
    spec,
    specIndex: index.sections,
  });
  const encoded = yield* encodeTrace(trace);
  // Formatted as `pnpm check` wants it: oxfmt decides which arrays fit on one line.
  const text = yield* sh(
    path.join(repo, "node_modules/.bin/oxfmt"),
    ["--stdin-filepath", OUTPUT],
    Stream.encodeText(Stream.make(Formatter.formatJson(encoded, { space: 2 }))),
  );
  return { file: path.join(repo, OUTPUT), text };
});

const demoTrace = Effect.fn("demo-trace")(function* ({ check }: { check: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const { file, text } = yield* build();
  if (check) {
    const committed = yield* fs.readFileString(file);
    yield* Option.match(firstDifference(committed, text), {
      onNone: () => Console.log(`${OUTPUT} is up to date`),
      onSome: (difference) => Effect.fail(new Stale({ difference })),
    });
  } else {
    // Replaced whole: the Vite dev server watches this file and would decode it half written.
    yield* replaceFile(file, text);
    yield* Console.log(`wrote ${OUTPUT}`);
  }
});

const command = Command.make(
  "demo-trace",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Write nothing; fail when the file differs from what would be written"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    demoTrace(input).pipe(
      Effect.tapErrorTag(["Stale", "CommandFailed"], (error) => Effect.logError(error.message)),
    ),
).pipe(Command.withDescription(`Regenerate ${OUTPUT} from the .cairn files`));

const logger = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(logger, NodeServices.layer)),
  NodeRuntime.runMain,
);
