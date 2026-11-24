import { matchesGlob } from "node:path";

import type { GateReason, HumanGate, ManifestTask, Section } from "@cairn/contract";
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

/** What `gateOf` reads from the config: the high-trust path patterns. */
export interface GateConfig {
  readonly humanPaths: readonly string[];
}

/** What `gateOf` reads from a task: the sections it links and the files it declares. */
export type GateTask = Pick<ManifestTask, "files" | "prdSections" | "specSections">;

const TAG_REASON: GateReason = "tag:human";

/** Whether any section the task links carries the `human` tag; an ancestor's tag is already in `Section.human`. */
const isTagged = (task: GateTask, sections: readonly Section[]): boolean => {
  const linked: readonly string[] = Array.appendAll(task.prdSections, task.specSections);
  return Array.some(
    sections,
    (section) =>
      section.human &&
      Option.exists(Option.fromUndefinedOr(section.id), (id) => Array.contains(linked, id)),
  );
};

/**
 * Whether a task needs a human, and why. It is gated by `tag:human` when a PRD or spec section it
 * links has the tag, and by `path:<pattern>` for each `config.humanPaths` pattern that matches a
 * file in `task.files` (plan time) or in `changedFiles` (after commits). Plan time passes no
 * changed files. A hit after commit adds a reason; it never removes one the plan found.
 */
export const gateOf = (
  task: GateTask,
  sections: readonly Section[],
  config: GateConfig,
  changedFiles: readonly string[],
): HumanGate => {
  const reasons: readonly GateReason[] = Array.appendAll(
    isTagged(task, sections) ? [TAG_REASON] : [],
    Array.map(
      patternsMatching(Array.dedupe(config.humanPaths), Array.appendAll(task.files, changedFiles)),
      (pattern): GateReason => `path:${pattern}`,
    ),
  );
  return { reasons, required: Array.isReadonlyArrayNonEmpty(reasons) };
};
