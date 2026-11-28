import type { ConflictsConfig, ManifestTask, TaskId, TaskStatus } from "@cairn/contract";
import {
  Array,
  HashMap,
  HashSet,
  Match,
  Number,
  Option,
  Order,
  Record,
  Result,
  String,
  Struct,
  pipe,
} from "effect";

import { matchesPath } from "./gates.ts";
import { indexOf } from "./relation-index.ts";
import type { RelationIndex } from "./relation-index.ts";
import { lineOf, parentOf, placedOn } from "./stack.ts";
import type { Ordering, StackLink } from "./stack.ts";
import { TaskIdOrder } from "./stacks.ts";

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

/** Every unordered pair of `items`, each once. */
const pairsOf = <A>(items: ReadonlyArray<A>): ReadonlyArray<readonly [A, A]> =>
  Array.flatMap(items, (item, at) =>
    Array.map(Array.drop(items, at + 1), (other) => [item, other] as const),
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

const FINISHED: ReadonlyArray<TaskStatus> = ["done", "landed"];

/**
 * The existing tasks a plan scores against its new ones: those that have not finished, which can
 * still run beside a new one. A finished task runs beside nothing.
 */
const openOf = (existing: ReadonlyArray<ManifestTask>): ReadonlyArray<ManifestTask> =>
  Array.filter(existing, ({ status }) => !Array.contains(FINISHED, status));

/** The relation index of a plan's tasks: `canRunTogether` reads only their dependencies. */
const taskIndexOf = (existing: ReadonlyArray<ManifestTask>, drafts: ReadonlyArray<ManifestTask>) =>
  indexOf({
    manifest: { tasks: Array.appendAll(existing, drafts) },
    prd: "",
    specIndex: { sections: [] },
  });

/**
 * Two tasks that can run at the same time and score above 0, named by ID, the earlier first, with
 * the score and its reasons as the plan output words them.
 */
export interface Conflict {
  readonly earlier: TaskId;
  readonly later: TaskId;
  /** The reasons as text: `shares packages/core/src/lint.ts (34 changes)`. */
  readonly reason: string;
  readonly score: Score;
}

/** ` (34 changes)` after a shared file, or nothing for a file the history never changed. */
const changesText = (changes: number): string =>
  changes === 0 ? "" : changes === 1 ? " (1 change)" : ` (${changes} changes)`;

/** How a reason reads in the plan output. A generated file counts for nothing and is left out. */
const reasonText = (history: History, reason: Reason): Option.Option<string> =>
  Match.value(reason.kind).pipe(
    Match.when("generated", () => Option.none()),
    Match.when("additive", () => Option.some(`adds to ${reason.file}`)),
    Match.when("shared", () =>
      Option.some(`shares ${reason.file}${changesText(changesOf(history, reason.file))}`),
    ),
    Match.when("coupled", () =>
      Option.map(
        Option.fromUndefinedOr(reason.other),
        (other) =>
          `${reason.file} changes with ${other} (${togetherOf(history, reason.file, other)} commits)`,
      ),
    ),
    Match.exhaustive,
  );

/**
 * The conflicts of a plan (see `spec.planning.conflict-ordering`): every pair of a new task with
 * another new task, or with an existing task that has not finished, that can run at the same time
 * and scores above 0. `drafts` are the new tasks as `stackOf` placed them after `existing`. A
 * task's files are its declared `files`.
 */
export const conflictsOf = (
  existing: ReadonlyArray<ManifestTask>,
  drafts: ReadonlyArray<ManifestTask>,
  history: History,
  config: ScoreConfig,
): ReadonlyArray<Conflict> => {
  const index = taskIndexOf(existing, drafts);
  const files = Record.fromIterableWith(Array.appendAll(existing, drafts), (task) => [
    task.id,
    task.files,
  ]);
  const filesOf = (id: TaskId) => Option.getOrElse(Record.get(files, id), () => []);
  return Array.getSomes(
    Array.map(
      Array.appendAll(Array.cartesian(openOf(existing), drafts), pairsOf(drafts)),
      ([a, b]) =>
        pipe(
          scoreOf(index, a.id, b.id, filesOf, history, config),
          Option.filter(({ score }) => score > 0),
          Option.map((score): Conflict => {
            const ascending = Order.isLessThan(TaskIdOrder)(a.id, b.id);
            return {
              earlier: ascending ? a.id : b.id,
              later: ascending ? b.id : a.id,
              reason: Array.join(
                Array.getSomes(Array.map(score.reasons, (reason) => reasonText(history, reason))),
                "; ",
              ),
              score,
            };
          }),
        ),
    ),
  );
};

/** Highest score first, then by the earlier task's ID and the later one's. */
export const conflictOrder: Order.Order<Conflict> = Order.combineAll([
  Order.mapInput(Order.flip(Order.Number), ({ score }: Conflict) => score.score),
  Order.mapInput(TaskIdOrder, ({ earlier }: Conflict) => earlier),
  Order.mapInput(TaskIdOrder, ({ later }: Conflict) => later),
]);

/** The ordering an applied conflict stands for: the later task stacked on the earlier one. */
export const orderingOf = ({ earlier, later, reason }: Conflict): Ordering => ({
  after: earlier,
  reason,
  task: later,
});

/** What `orderingsOf` did with each high-scoring pair, highest score first. */
export interface Orderings {
  /** Pairs whose later task is stacked on the earlier one through `orderedAfter`. */
  readonly applied: ReadonlyArray<Conflict>;
  /** Pairs left as a recommendation for a person: start the later task after the earlier lands. */
  readonly recommended: ReadonlyArray<Conflict>;
}

/** A task no human gate holds, which may be stacked on another task or have one stacked on it. */
const free = (task: ManifestTask) => !task.humanGate.required;

/**
 * The parent links of `existing` and then `drafts`, each draft placed again under `orderings` as
 * `stackOf` would place it.
 */
const linksWith = (
  index: RelationIndex,
  existing: ReadonlyArray<ManifestTask>,
  drafts: ReadonlyArray<ManifestTask>,
  orderings: ReadonlyArray<Ordering>,
): ReadonlyArray<StackLink> =>
  Array.reduce(
    drafts,
    Array.map(existing, Struct.pick(["id", "parent"])),
    (links: ReadonlyArray<StackLink>, task) =>
      Array.append(links, {
        id: task.id,
        parent: Option.getOrNull(
          placedOn(
            {
              dependsOn: task.dependsOn,
              humanGate: task.humanGate,
              orderedAfter: Array.filterMap(orderings, ({ after, reason, task: ordered }) =>
                ordered === task.id ? Result.succeed({ reason, task: after }) : Result.failVoid,
              ),
            },
            links,
            (other) => Array.contains(index.needsAll(task.id), other),
          ),
        ),
      }),
  );

/**
 * What to do about each high-scoring pair (see `spec.planning.conflict-ordering`). Pure. It runs
 * after `stackOf` has placed `drafts`, the new tasks, after `existing`, and walks the pairs of
 * `conflicts` that score at least `high`, highest first.
 *
 * - When both tasks are new and neither is gated, the later one is stacked on the earlier one,
 *   provided its dependencies and the earlier task lie on one chain, so that it gets a parent,
 *   it is not already stacked on another task, no task would come to sit above a gated task it
 *   does not need and wait on it, and no gated task that sits on the stack its dependencies give
 *   would lose it. A task it does not need sliding below it would do that, since
 *   `placedOn` then starts it from the base branch (`prd.human-gates`).
 * - Any other pair is recommended: one with an existing task, a gated task, a later task whose
 *   dependencies lie on other stacks, or one that would hold a task behind a gate it does not
 *   need or push a gate off its stack.
 *   Nothing in the manifest changes for it.
 *
 * Run again over the applied pairs that are left after one is taken out, it keeps those that
 * still fit and recommends the ones that only fitted on the chain the removed one made.
 *
 * Gates are read from each task's `humanGate`. `stackOf` with `Array.map(applied, orderingOf)`
 * writes the applied orderings.
 */
export const orderingsOf = (
  drafts: ReadonlyArray<ManifestTask>,
  existing: ReadonlyArray<ManifestTask>,
  conflicts: ReadonlyArray<Conflict>,
  config: Pick<ConflictsConfig, "high">,
): Orderings => {
  const byId = Record.fromIterableWith(drafts, (task) => [task.id, task]);
  const index = taskIndexOf(existing, drafts);
  const gated = Array.filter(drafts, (task) => !free(task));
  // The gated drafts that `links` leave on the stack their dependencies give them: nothing below
  // that parent is a task they do not need. `placedOn` starts any other from the base branch.
  const keptGates = (links: ReadonlyArray<StackLink>) => {
    const parents = Record.fromEntries(Array.map(links, (link) => [link.id, link.parent] as const));
    return HashSet.fromIterable(
      Array.filterMap(gated, (gate) => {
        const needs = index.needsAll(gate.id);
        return Option.match(parentOf(gate.dependsOn, links), {
          onNone: () => true,
          onSome: (on) => Array.every(lineOf(parents, on), (below) => Array.contains(needs, below)),
        })
          ? Result.succeed(gate.id)
          : Result.failVoid;
      }),
    );
  };
  const gatedIds = HashSet.fromIterable(
    Array.filterMap(Array.appendAll(existing, drafts), (task) =>
      free(task) ? Result.failVoid : Result.succeed(task.id),
    ),
  );
  // Each task that `links` put above a gated task it does not need, which would wait on that gate.
  const heldOf = (links: ReadonlyArray<StackLink>) => {
    const parents = Record.fromEntries(Array.map(links, (link) => [link.id, link.parent] as const));
    return HashSet.fromIterable(
      Array.flatMap(links, ({ id }) => {
        const needs = index.needsAll(id);
        return Array.filterMap(Array.drop(lineOf(parents, id), 1), (below) =>
          HashSet.has(gatedIds, below) && !Array.contains(needs, below)
            ? Result.succeed(`${id} ${below}`)
            : Result.failVoid,
        );
      }),
    );
  };
  // What the stack looks like under the orderings applied so far; it changes only when one is applied.
  const stateOf = (applied: ReadonlyArray<Conflict>) => {
    const links = linksWith(index, existing, drafts, Array.map(applied, orderingOf));
    return { held: heldOf(links), kept: keptGates(links), links };
  };
  const start = Struct.assign(stateOf([]), {
    applied: Array.empty<Conflict>(),
    recommended: Array.empty<Conflict>(),
  });
  const done = Array.reduce(
    Array.sort(
      Array.filter(conflicts, ({ score }) => score.score >= config.high),
      conflictOrder,
    ),
    start,
    (sofar, conflict) => {
      // The cheap checks first; only a pair that passes them is tried on the whole stack.
      const eligible = Option.exists(
        Option.all([Record.get(byId, conflict.earlier), Record.get(byId, conflict.later)]),
        ([earlier, later]) =>
          free(earlier) &&
          free(later) &&
          !Array.some(sofar.applied, (applied) => applied.later === later.id) &&
          Option.isSome(parentOf(Array.append(later.dependsOn, earlier.id), sofar.links)),
      );
      const tried = eligible
        ? Option.some(stateOf(Array.append(sofar.applied, conflict)))
        : Option.none();
      return Option.match(
        Option.filter(
          tried,
          (next) =>
            HashSet.isSubset(sofar.kept, next.kept) && HashSet.isSubset(next.held, sofar.held),
        ),
        {
          onNone: () =>
            Struct.evolve(sofar, { recommended: (left) => Array.append(left, conflict) }),
          onSome: (next) =>
            Struct.assign(next, {
              applied: Array.append(sofar.applied, conflict),
              recommended: sofar.recommended,
            }),
        },
      );
    },
  );
  return { applied: done.applied, recommended: done.recommended };
};

/** A maximum matching between each task and the tasks that need it, grown one path at a time. */
interface Matching {
  /** The task each later task is matched to: the one it needs. */
  readonly matched: HashMap.HashMap<TaskId, TaskId>;
  /** The later tasks this search for a path has already tried. */
  readonly tried: HashSet.HashSet<TaskId>;
}

/**
 * Kuhn's search for an augmenting path from `earlier`: whether `earlier` could be matched to a
 * task that needs it, moving matched tasks along, and the matching after the search.
 */
const augment = (
  later: (id: TaskId) => ReadonlyArray<TaskId>,
  earlier: TaskId,
  search: Matching,
): readonly [boolean, Matching] =>
  Array.reduce(
    later(earlier),
    [false, search] as const,
    ([found, current], next): readonly [boolean, Matching] => {
      if (found || HashSet.has(current.tried, next)) {
        return [found, current];
      }
      const trying: Matching = {
        matched: current.matched,
        tried: HashSet.add(current.tried, next),
      };
      const [moved, after] = Option.match(HashMap.get(trying.matched, next), {
        onNone: () => [true, trying] as const,
        onSome: (holder) => augment(later, holder, trying),
      });
      return moved
        ? [true, { matched: HashMap.set(after.matched, next, earlier), tried: after.tried }]
        : [false, after];
    },
  );

/** The tasks an alternating path reaches from an unmatched one: each as an earlier task and as a later one. */
interface Reached {
  readonly earlier: HashSet.HashSet<TaskId>;
  readonly later: HashSet.HashSet<TaskId>;
}

/** From `earlier` along every task that needs it, and from a later task back along its match. */
const reachFrom = (
  later: (id: TaskId) => ReadonlyArray<TaskId>,
  matched: HashMap.HashMap<TaskId, TaskId>,
  earlier: TaskId,
  reached: Reached,
): Reached =>
  HashSet.has(reached.earlier, earlier)
    ? reached
    : Array.reduce(
        later(earlier),
        { earlier: HashSet.add(reached.earlier, earlier), later: reached.later },
        (sofar: Reached, next) => {
          if (HashSet.has(sofar.later, next)) {
            return sofar;
          }
          const withNext = { earlier: sofar.earlier, later: HashSet.add(sofar.later, next) };
          return Option.match(HashMap.get(matched, next), {
            onNone: () => withNext,
            onSome: (holder) => reachFrom(later, matched, holder, withNext),
          });
        },
      );

/**
 * A largest subset of `ids` whose tasks can all run with one another: a maximum antichain of what
 * the tasks need, in polynomial time. Kuhn's algorithm matches each task to one that needs it,
 * directly or through other tasks; by Dilworth's and König's theorems the tasks an alternating
 * path from an unmatched task reaches as needed but not as needing are such a set.
 */
const antichainOf = (index: RelationIndex, ids: ReadonlyArray<TaskId>): ReadonlyArray<TaskId> => {
  const needs = Record.fromIterableWith(ids, (id) => [id, index.needsAll(id)]);
  const later = (earlier: TaskId) =>
    Array.filter(
      ids,
      (other) =>
        other !== earlier &&
        Option.exists(Record.get(needs, other), (needed) => Array.contains(needed, earlier)),
    );
  const matched = Array.reduce(
    ids,
    HashMap.empty<TaskId, TaskId>(),
    (sofar, earlier) =>
      augment(later, earlier, { matched: sofar, tried: HashSet.empty() })[1].matched,
  );
  const holders = HashSet.fromIterable(HashMap.values(matched));
  const reached = Array.reduce(
    Array.filter(ids, (id) => !HashSet.has(holders, id)),
    { earlier: HashSet.empty<TaskId>(), later: HashSet.empty<TaskId>() },
    (sofar: Reached, unmatched) => reachFrom(later, matched, unmatched, sofar),
  );
  return Array.filter(
    ids,
    (id) => HashSet.has(reached.earlier, id) && !HashSet.has(reached.later, id),
  );
};

/**
 * The largest subset of `ids`, in their order, whose tasks can all run with one another; of two
 * the same size, the one with the earlier tasks. Walking `ids` in order, a task is taken when a
 * set that large is still possible with it, which `antichainOf` measures. A trunk task and the
 * siblings that need it share no subset, so the siblings alone count.
 */
const largestTogether = (
  index: RelationIndex,
  ids: ReadonlyArray<TaskId>,
): ReadonlyArray<TaskId> => {
  const size = Array.length(antichainOf(index, ids));
  return Array.reduce(ids, { left: ids, taken: Array.empty<TaskId>() }, ({ left, taken }, id) => {
    const rest = Array.filter(left, (other) => other !== id);
    const withId = Array.filter(rest, (other) => index.canRunTogether(id, other));
    return Array.contains(left, id) &&
      Array.length(taken) + 1 + Array.length(antichainOf(index, withId)) === size
      ? { left: withId, taken: Array.append(taken, id) }
      : { left: rest, taken };
  }).taken;
};

/** A source file that `conflicts.hotspot` or more tasks that can run together all change. */
export interface Hotspot {
  readonly path: string;
  /** The tasks, in plan order. */
  readonly tasks: ReadonlyArray<TaskId>;
}

/**
 * The files the stack checkpoint asks `separable` about (see `spec.planning.conflict-ordering`):
 * each plain file, neither generated nor additive nor a directory, that at least `hotspot` of the
 * plan's tasks change and can all run together; a task that declares a directory changes every
 * file in it. The tasks are the new ones and the existing ones
 * that have not finished. The tasks named are the largest set of those that change the file whose
 * tasks can all run with one another, in plan order.
 */
export const hotspotsOf = (
  existing: ReadonlyArray<ManifestTask>,
  drafts: ReadonlyArray<ManifestTask>,
  config: Pick<ConflictsConfig, "additive" | "generated" | "hotspot">,
): ReadonlyArray<Hotspot> => {
  const index = taskIndexOf(existing, drafts);
  const tasks = Array.appendAll(openOf(existing), drafts);
  const files = Array.sort(
    couplable(config, Array.dedupe(Array.flatMap(tasks, ({ files: declared }) => declared))),
    Order.String,
  );
  return Array.filterMap(files, (path) => {
    const together = largestTogether(
      index,
      Array.filterMap(tasks, ({ files: declared, id }) =>
        Array.some(declared, (covering) => covers(covering, path))
          ? Result.succeed(id)
          : Result.failVoid,
      ),
    );
    return Array.length(together) >= config.hotspot
      ? Result.succeed({ path, tasks: together })
      : Result.failVoid;
  });
};
