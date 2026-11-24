import { matchesGlob } from "node:path";

import { Array, Option, String, pipe } from "effect";

/** The name a file would have inside a declared directory. */
const PROBE = "x";

const isDirectory = String.endsWith("/");

const fileName = (file: string): string =>
  pipe(
    String.split(file, "/"),
    Array.last,
    Option.getOrElse(() => file),
  );

/** A pattern without a `/` matches the file name in any directory, as in gitignore. */
const matchesFile = (pattern: string, file: string): boolean =>
  String.includes("/")(pattern) ? matchesGlob(file, pattern) : matchesGlob(fileName(file), pattern);

/**
 * Whether a gate pattern matches a path a task declares. The pattern uses `path.matchesGlob`, with
 * one gitignore rule added: a pattern without a `/` matches the file name in any directory. A
 * declared path ending in `/` is a directory and matches when a file inside it would, which Cairn
 * tests with a file named `x` in that directory.
 */
export const matchesPath = (pattern: string, declared: string): boolean =>
  matchesFile(pattern, isDirectory(declared) ? `${declared}${PROBE}` : declared);

/** The patterns, in their own order, that match at least one of the paths. */
export const patternsMatching = (
  patterns: readonly string[],
  paths: readonly string[],
): readonly string[] =>
  Array.filter(patterns, (pattern) => Array.some(paths, (path) => matchesPath(pattern, path)));
