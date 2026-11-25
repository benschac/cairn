import { matchesGlob } from "node:path";

import type { GateReason, HumanGate, ManifestTask, Section } from "@cairn/contract";
import { Array, HashSet, Option, String, pipe } from "effect";

import type { Item } from "./items.ts";

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

/** What `gateOf` reads of a list item: whether it is human, and its ID if it has one. */
export type GateItem = Pick<Item, "human" | "id">;

/**
 * Whether any section or item the task links carries the `human` tag, or a spec section it builds
 * implements a human item (see `spec.sections.item-coverage`). An ancestor's tag is already in
 * `Section.human` and `Item.human`.
 */
const isTagged = (
  task: GateTask,
  sections: readonly Pick<Section, "human" | "id" | "keys">[],
  items: readonly GateItem[],
): boolean => {
  const linked: readonly string[] = Array.appendAll(task.prdSections, task.specSections);
  const built: readonly string[] = task.specSections;
  const humanItems = HashSet.fromIterable<string>(
    Array.getSomes(
      Array.map(items, (item) => (item.human ? Option.fromUndefinedOr(item.id) : Option.none())),
    ),
  );
  return (
    Array.some(
      Array.appendAll<GateItem, GateItem>(sections, items),
      (linkable) =>
        linkable.human &&
        Option.exists(Option.fromUndefinedOr(linkable.id), (id) => Array.contains(linked, id)),
    ) ||
    Array.some(
      sections,
      ({ id, keys }) =>
        Option.exists(Option.fromUndefinedOr(id), (own) => Array.contains(built, own)) &&
        Array.some(keys.implements, (named) => HashSet.has(humanItems, named)),
    )
  );
};

/**
 * Whether a task needs a human, and why. It is gated by `tag:human` when a PRD or spec section or
 * item it links has the tag, or when a spec section it builds implements a human item, and by `path:<pattern>` for each `config.humanPaths` pattern that matches a
 * file in `task.files` (plan time) or in `changedFiles` (after commits). Plan time passes no
 * changed files. A hit after commit adds a reason; it never removes one the plan found. `items`
 * are the PRD's list items, whose own markers and ancestors set `human`.
 */
export const gateOf = (
  task: GateTask,
  sections: readonly Section[],
  config: GateConfig,
  changedFiles: readonly string[],
  items: readonly GateItem[] = [],
): HumanGate => {
  const reasons: readonly GateReason[] = Array.appendAll(
    isTagged(task, sections, items) ? [TAG_REASON] : [],
    Array.map(
      patternsMatching(Array.dedupe(config.humanPaths), Array.appendAll(task.files, changedFiles)),
      (pattern): GateReason => `path:${pattern}`,
    ),
  );
  return { reasons, required: Array.isReadonlyArrayNonEmpty(reasons) };
};
