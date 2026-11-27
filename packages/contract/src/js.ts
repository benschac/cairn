import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { Array, Option, Result, Schema, SchemaIssue, String, pipe } from "effect";

import { Config } from "./config.ts";
import { Event, EventJson } from "./events.ts";
import { Manifest } from "./manifest.ts";
import { type Trailers, formatTrailers } from "./trailers.ts";

export { formatTrailers };

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

const NEWLINE = 10;
const decodeEvent: (input: unknown) => Event = parser(Event);
const encodeEventLine = Schema.encodeSync(EventJson);

/**
 * Appends one event to `events.jsonl` as a single `O_APPEND` write of one line, so concurrent
 * writers never interleave. The event is validated first, as the encoded object a JavaScript
 * caller has to hand (`ts` a string; `v` and `actor` may be left out and are written in);
 * an invalid one throws a `CairnContractError` and writes nothing. A file whose last line has no
 * newline gets one first, in the same write (readers skip the blank line two such writers can leave).
 * A short write throws instead of leaving a torn line behind.
 */
export const appendEvent = (path: string, event: unknown): void => {
  const line = `${encodeEventLine(decodeEvent(event))}\n`;
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_RDWR);
  try {
    const { size } = fstatSync(fd);
    const last = Buffer.alloc(1);
    const unterminated =
      size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== NEWLINE;
    const bytes = Buffer.from(unterminated ? `\n${line}` : line, "utf8");
    const written = writeSync(fd, bytes);
    if (written !== bytes.length) {
      throw new CairnContractError({
        message: `wrote ${written} of ${bytes.length} bytes to ${path}`,
        path: "",
      });
    }
  } finally {
    closeSync(fd);
  }
};

/** The trailer block as `--trailer` arguments for `git commit`, one pair per trailer line. */
export const trailerArgs = (trailers: Trailers): ReadonlyArray<string> =>
  Array.flatMap(String.split(formatTrailers(trailers), "\n"), (line) => ["--trailer", line]);

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
