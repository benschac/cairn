import type { ConflictsConfig, TaskId } from "@cairn/contract";
import { Array, HashMap, Number, Option, Order, String, pipe } from "effect";

import { matchesPath } from "./gates.ts";
import type { RelationIndex } from "./relation-index.ts";

/** A commit with more files than this is a mass edit, and says nothing about which files go together. */
const MASS_EDIT = 20;

/** Two files are coupled when they changed together in at least this many commits... */
const MIN_TOGETHER = 3;

/** ...and in at least this share of the commits of the one that changed less. */
const MIN_SHARE = 0.5;

/** The commits at which a file's churn stops growing: a file changed this often weighs twice as much. */
const CHURN_CAP = 50;

/** No reason counts for more than this, so a score never reaches 1. */
const MAX_WEIGHT = 0.95;

/** The largest number below 1: the product of many small factors rounds `1 - product` up to 1 otherwise. */
const MAX_SCORE = 0.9999999999999999;

const SHARED_WEIGHT = 0.5;
const COUPLED_WEIGHT = 0.25;
const ADDITIVE_WEIGHT = 0.1;

/** What the history of a repo says about its files (see `spec.planning.conflict-scores`). */
export interface History {
  /** The number of commits that changed each file. */
  readonly changes: HashMap.HashMap<string, number>;
  /** The number of commits that changed each pair of files, keyed by `pairKey`. */
  readonly together: HashMap.HashMap<string, number>;
}

/** The part of a commit `historyOf` reads. */
export interface ChangedFiles {
  readonly files: ReadonlyArray<string>;
}

/** The key of an unordered pair of files in `History.together`. */
export const pairKey = (a: string, b: string): string =>
  Order.isLessThan(Order.String)(a, b) ? `${a}\0${b}` : `${b}\0${a}`;

const bump = <K>(counts: HashMap.HashMap<K, number>, key: K): HashMap.HashMap<K, number> =>
  HashMap.modifyAt(counts, key, (count) =>
    Option.some(Option.getOrElse(Option.map(count, Number.increment), () => 1)),
  );

/** Every unordered pair of `files`, each once. */
const pairsOf = (files: ReadonlyArray<string>): ReadonlyArray<readonly [string, string]> =>
  Array.flatMap(files, (file, at) =>
    Array.map(Array.drop(files, at + 1), (other) => [file, other] as const),
  );

/**
 * Each file's change count and each pair's co-change count over `commits`. A commit that touches
 * more than 20 files is a mass edit and is left out.
 */
export const historyOf = (commits: ReadonlyArray<ChangedFiles>): History =>
  Array.reduce(
    Array.filter(commits, ({ files }) => Array.length(Array.dedupe(files)) <= MASS_EDIT),
    { changes: HashMap.empty<string, number>(), together: HashMap.empty<string, number>() },
    (history, { files }) => {
      const unique = Array.sort(Array.dedupe(files), Order.String);
      return {
        changes: Array.reduce(unique, history.changes, bump),
        together: Array.reduce(pairsOf(unique), history.together, (counts, [a, b]) =>
          bump(counts, pairKey(a, b)),
        ),
      };
    },
  );

/** How many commits changed `file`. */
export const changesOf = (history: History, file: string): number =>
  Option.getOrElse(HashMap.get(history.changes, file), () => 0);

/** How many commits changed both files. */
export const togetherOf = (history: History, a: string, b: string): number =>
  Option.getOrElse(HashMap.get(history.together, pairKey(a, b)), () => 0);

export type ReasonKind = "additive" | "coupled" | "generated" | "shared";

/** Why a pair scores: a file, the file it is coupled with if any, how it counts and by how much. */
export interface Reason {
  readonly file: string;
  readonly kind: ReasonKind;
  readonly other?: string;
  readonly weight: number;
}

export interface Score {
  /** In [0, 1). */
  readonly score: number;
  readonly reasons: ReadonlyArray<Reason>;
}

/** The part of the config `scoreOf` reads. */
export type ScoreConfig = Pick<ConflictsConfig, "additive" | "generated">;

/** `1` for a file that rarely changes, up to `2` for one that changes often. */
const churnOf = (changes: number): number => 1 + Number.min(1, changes / CHURN_CAP);

const isDirectory = String.endsWith("/");

/** A declared file covers itself; a declared directory covers every path inside it. */
const covers = (declared: string, path: string): boolean =>
  isDirectory(declared) ? String.startsWith(declared)(path) : declared === path;

/** The more specific of two declared paths when they overlap: the file a directory holds, or the deeper directory. */
const overlapOf = (a: string, b: string): Option.Option<string> =>
  covers(a, b) ? Option.some(b) : covers(b, a) ? Option.some(a) : Option.none();

const matchesAny = (patterns: ReadonlyArray<string>, file: string): boolean =>
  Array.some(patterns, (pattern) => matchesPath(pattern, file));

/** The reason a file both tasks change counts for: generated files count for nothing, additive ones for little. */
const sharedReason = (config: ScoreConfig, history: History, file: string): Reason =>
  matchesAny(config.generated, file)
    ? { file, kind: "generated", weight: 0 }
    : matchesAny(config.additive, file)
      ? { file, kind: "additive", weight: ADDITIVE_WEIGHT }
      : { file, kind: "shared", weight: SHARED_WEIGHT * churnOf(changesOf(history, file)) };

/** Whether two files changed together often enough, and often enough for the one that changed less. */
const isCoupled = (history: History, a: string, b: string): boolean => {
  const together = togetherOf(history, a, b);
  return (
    together >= MIN_TOGETHER &&
    together >= MIN_SHARE * Number.min(changesOf(history, a), changesOf(history, b))
  );
};

/**
 * Files that count for coupling: a plain file that is neither generated nor additive, since a
 * restack rebuilds the first and merges the second.
 */
const couplable = (config: ScoreConfig, files: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.filter(
    files,
    (file) =>
      !isDirectory(file) &&
      !matchesAny(config.generated, file) &&
      !matchesAny(config.additive, file),
  );

const reasonOrder: Order.Order<Reason> = Order.combineAll([
  Order.mapInput(Order.flip(Order.Number), ({ weight }: Reason) => weight),
  Order.mapInput(Order.String, ({ file }: Reason) => file),
  Order.mapInput(Order.String, ({ other }: Reason) =>
    Option.getOrElse(Option.fromUndefinedOr(other), () => ""),
  ),
]);

/**
 * How likely two tasks that run at the same time are to conflict, with the reasons (see
 * `spec.planning.conflict-scores`). `files` gives the files a task changes: its declared files at
 * plan time, its diff once it runs. A directory ending in `/` stands for every file inside it. It
 * is none for a pair where one task needs the other, directly or through other tasks, since those
 * never run together.
 */
export const scoreOf = (
  index: Pick<RelationIndex, "canRunTogether">,
  a: TaskId,
  b: TaskId,
  files: (task: TaskId) => ReadonlyArray<string>,
  history: History,
  config: ScoreConfig,
): Option.Option<Score> => {
  if (!index.canRunTogether(a, b)) {
    return Option.none();
  }
  const filesA = Array.dedupe(files(a));
  const filesB = Array.dedupe(files(b));
  const shared = Array.map(
    Array.dedupe(
      Array.getSomes(Array.map(Array.cartesian(filesA, filesB), ([x, y]) => overlapOf(x, y))),
    ),
    (file) => sharedReason(config, history, file),
  );
  const coupled = pipe(
    Array.cartesian(couplable(config, filesA), couplable(config, filesB)),
    Array.filter(([x, y]) => x !== y && isCoupled(history, x, y)),
    Array.dedupeWith(([x1, y1], [x2, y2]) => pairKey(x1, y1) === pairKey(x2, y2)),
    Array.map(([file, other]): Reason => ({
      file,
      kind: "coupled",
      other,
      weight:
        COUPLED_WEIGHT * churnOf(Number.max(changesOf(history, file), changesOf(history, other))),
    })),
  );
  const reasons = Array.sort(Array.appendAll(shared, coupled), reasonOrder);
  return Option.some({
    reasons,
    score: Number.min(
      MAX_SCORE,
      1 -
        Number.multiplyAll(Array.map(reasons, ({ weight }) => 1 - Number.min(MAX_WEIGHT, weight))),
    ),
  });
};
