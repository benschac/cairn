import { Array, Console, Effect, FileSystem, Path, Runtime, Schema, String } from "effect";
import { Command } from "effect/cli";

import { defaultConfig } from "@cairn/contract";

import { replaceFile } from "../atomic-write.ts";
import { MainCheckout } from "../main-checkout.ts";

export const CAIRN_DIRECTORY = ".cairn";
export const IGNORED_LINE = ".cairn/cairn.db";
/** The part of the config `cairn init` writes out, pretty-printed. */
const InitConfigJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), humanPaths: Schema.Array(Schema.String) }),
  { space: 2 },
);

/**
 * The config `cairn init` writes: the version and the default `humanPaths`, listed so a project
 * sees them and edits them for its own stack (`spec.cli`). Every other field decodes to its default.
 */
export const DEFAULT_CONFIG = `${Schema.encodeSync(InitConfigJson)({
  version: 1,
  humanPaths: defaultConfig.humanPaths,
})}\n`;

/** `.cairn/` is already there, so init changed nothing. */
export class AlreadyInitialized extends Schema.TaggedError<
  AlreadyInitialized,
  { readonly brand: unique symbol }
>()("AlreadyInitialized", { directory: Schema.String }) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `${this.directory} already exists; cairn init does not overwrite it`;
  }
}

/**
 * `existing` with the line added, or unchanged when it already has the line. Git ignores a
 * pattern's trailing spaces but keeps its leading ones, so an indented line does not count.
 */
export const withIgnoredLine = (existing: string): string =>
  Array.some(String.split("\n")(existing), (line) => String.trimEnd(line) === IGNORED_LINE)
    ? existing
    : `${existing}${String.isEmpty(existing) || String.endsWith("\n")(existing) ? "" : "\n"}${IGNORED_LINE}\n`;

/**
 * Creates `.cairn/` in the main checkout and ignores its database. Refuses, changing nothing, when `.cairn/` exists.
 *
 * The new `.cairn/` is built whole in a staging directory in the repository root and renamed into place, so a
 * failed or interrupted init leaves no `.cairn/` behind for the next init to refuse. A rename onto a directory
 * that is not empty fails (`ENOTEMPTY`, which the platform reports as `Unknown`) but one onto an empty
 * directory replaces it, so the check up front stays, and a rename that fails because `.cairn/` appeared since
 * is reported as `AlreadyInitialized`. `.gitignore` is written after the rename, by the init that made `.cairn/`.
 */
export const init = Effect.fn("init")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  const directory = path.join(root, CAIRN_DIRECTORY);
  yield* fs.exists(directory).pipe(
    Effect.filterOrFail(
      (taken) => !taken,
      () => new AlreadyInitialized({ directory }),
    ),
  );
  const templatePath = yield* path.fromFileUrl(new URL("../templates/prd.md", import.meta.url));
  const template = yield* fs.readFileString(templatePath);
  const gitignore = path.join(root, ".gitignore");
  const gitignoreText = fs
    .exists(gitignore)
    .pipe(
      Effect.flatMap((present) => (present ? fs.readFileString(gitignore) : Effect.succeed(""))),
    );
  // A .gitignore init cannot read fails it here, before .cairn/ exists for the next init to refuse.
  yield* gitignoreText;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: ".init-" });
      const draft = path.join(staging, CAIRN_DIRECTORY);
      yield* fs.makeDirectory(draft);
      yield* fs.writeFileString(path.join(draft, "prd.md"), template);
      yield* fs.writeFileString(path.join(draft, "events.jsonl"), "");
      yield* fs.writeFileString(path.join(draft, "config.json"), DEFAULT_CONFIG);
      yield* fs.rename(draft, directory).pipe(
        Effect.catchTag("PlatformError", (error) =>
          fs.exists(directory).pipe(
            Effect.filterOrFail(
              (taken) => !taken,
              () => new AlreadyInitialized({ directory }),
            ),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
    }),
  );
  // Only the init whose rename won touches .gitignore, so one that lost a race leaves it as the winner left it.
  // It is read again, so an edit made since the check above is kept.
  const existing = yield* gitignoreText;
  yield* replaceFile(gitignore, withIgnoredLine(existing));
  yield* Console.log(`Created ${directory}. Write your PRD in ${path.join(directory, "prd.md")}.`);
});

export const initCommand = Command.make("init", {}, () =>
  init().pipe(
    // The failure logs its own message once; the runtime does not print it again.
    Effect.tapErrorTag("AlreadyInitialized", (error) => Effect.logError(error.message)),
  ),
).pipe(Command.withDescription("Create .cairn/ with a PRD template, an events log and a config"));
