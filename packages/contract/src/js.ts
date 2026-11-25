import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

import { Array, Option, Result, Schema, SchemaIssue, String, pipe } from "effect";

import { Config } from "./config.ts";
import { EventJson } from "./events.ts";
import { Manifest } from "./manifest.ts";

export { formatTrailers } from "./trailers.ts";

/** Thrown by the functions of `@cairn/contract/js`: `path` is the field that was refused, empty for the whole input. */
export class CairnContractError extends Schema.TaggedError<
  CairnContractError,
  { readonly brand: unique symbol }
>()("CairnContractError", {
  message: Schema.String,
  path: Schema.String,
}) {}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

const fail = (error: Schema.SchemaError): never => {
  const issue = pipe(
    Array.head(formatIssue(error.issue).issues),
    Option.getOrElse(() => ({ message: error.message, path: [] as ReadonlyArray<unknown> })),
  );
  throw new CairnContractError({
    message: issue.message,
    path: Array.join(Array.map(issue.path ?? [], globalThis.String), "."),
  });
};

const parser =
  <A>(schema: Schema.Decoder<A>) =>
  (input: unknown): A =>
    Result.match(Schema.decodeUnknownResult(schema)(input), {
      onFailure: fail,
      onSuccess: (value) => value,
    });

/** The decoded manifest, or a thrown `CairnContractError`. */
export const parseManifest: (input: unknown) => Manifest = parser(Manifest);

/** One line of `events.jsonl` as an event, or a thrown `CairnContractError`. */
export const parseEvent: (line: string) => typeof EventJson.Type = parser(EventJson);

/** The decoded configuration, defaults filled, or a thrown `CairnContractError`. */
export const parseConfig: (input: unknown) => Config = parser(Config);

const VersionOnly = Schema.Struct({ version: Schema.Literal(1) });
const checkVersion = parser(VersionOnly);

/** Version 1 is the only version, so this checks it and returns the input. */
export const migrateManifest = (input: unknown): unknown => {
  checkVersion(input);
  return input;
};

/**
 * The main checkout's `.cairn/`, found from git's common directory the way the CLI does,
 * so a linked worktree reaches the same directory as everyone else.
 */
export const cairnDir = (cwd: string): string => {
  const commonDir = String.trim(
    execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (basename(commonDir) !== ".git") {
    throw new CairnContractError({
      message: `${commonDir} is not a .git directory`,
      path: "cwd",
    });
  }
  return join(dirname(commonDir), ".cairn");
};
