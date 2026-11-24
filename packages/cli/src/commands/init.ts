import { Array, Console, Effect, FileSystem, Path, Runtime, Schema, String } from "effect";
import { Command } from "effect/cli";

import { defaultConfig } from "@cairn/contract";

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

/** Creates `.cairn/` in the main checkout and ignores its database. Refuses, changing nothing, when `.cairn/` exists. */
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
  const hasGitignore = yield* fs.exists(gitignore);
  const existing = hasGitignore ? yield* fs.readFileString(gitignore) : "";
  yield* fs.makeDirectory(directory);
  yield* fs.writeFileString(path.join(directory, "prd.md"), template);
  yield* fs.writeFileString(path.join(directory, "events.jsonl"), "");
  yield* fs.writeFileString(path.join(directory, "config.json"), DEFAULT_CONFIG);
  yield* fs.writeFileString(gitignore, withIgnoredLine(existing));
  yield* Console.log(`Created ${directory}. Write your PRD in ${path.join(directory, "prd.md")}.`);
});

export const initCommand = Command.make("init", {}, () =>
  init().pipe(
    // The failure logs its own message once; the runtime does not print it again.
    Effect.tapErrorTag("AlreadyInitialized", (error) => Effect.logError(error.message)),
  ),
).pipe(Command.withDescription("Create .cairn/ with a PRD template, an events log and a config"));
