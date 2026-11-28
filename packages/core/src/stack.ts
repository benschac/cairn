import { TaskId } from "@cairn/contract";
import type { HumanGate, ManifestTask, OrderedAfter, Slug, TaskDraft } from "@cairn/contract";
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
  Schema,
  String,
  pipe,
} from "effect";

/** What kept the drafts from being ordered (see `spec.planning.stack-order`). */
export const StackProblem = Schema.Literals(["duplicate-title", "unknown-dependency", "cycle"]);
export type StackProblem = typeof StackProblem.Type;

/**
 * Why `stackOf` could not order the drafts. `titles` names them: the title two drafts share; a
 * draft and what it depends on that is neither a draft's title nor an existing task's ID; or the
 * drafts of a cycle in order, each depending on the next and the last on the first.
 */
export class StackOrderError extends Schema.TaggedError<
  StackOrderError,
  { readonly brand: unique symbol }
>()("StackOrderError", {
  problem: StackProblem,
  titles: Schema.NonEmptyArray(Schema.String),
}) {
  override get message() {
    const quoted = Array.map(this.titles, (title) => `"${title}"`);
    return Match.value(this.problem).pipe(
      Match.when(
        "duplicate-title",
        () => `Two drafts have the title ${Array.headNonEmpty(quoted)}.`,
      ),
      Match.when(
        "unknown-dependency",
        () =>
          `${Array.join(quoted, " depends on ")}, which is the title of no draft and the ID of no task in the manifest.`,
      ),
      Match.when(
        "cycle",
        () =>
          `Drafts depend on each other in a cycle: ${Array.join(
            Array.append(quoted, Array.headNonEmpty(quoted)),
            " depends on ",
          )}.`,
      ),
      Match.exhaustive,
    );
  }
}

/**
 * A conflict ordering `stackOf` applies (see `spec.planning.conflict-ordering`): `task` is
 * stacked on `after` for `reason`, without depending on it.
 */
export interface Ordering {
  readonly after: TaskId;
  readonly reason: string;
  readonly task: TaskId;
}

/**
 * What a task's parent is computed from: the tasks it depends on, then the tasks it is ordered
 * after. `parentOf` over these gives the parent `stackOf` sets and `parent-mismatch` expects.
 */
export const stackedOn = (
  task: Pick<ManifestTask, "dependsOn" | "orderedAfter">,
): ReadonlyArray<TaskId> =>
  Array.appendAll(
    task.dependsOn,
    Array.map(task.orderedAfter, ({ task: after }) => after),
  );

/** What `parentOf` reads from each task placed so far. */
export type StackLink = Pick<ManifestTask, "id" | "parent">;

/** What `worktreesOf` reads from each task. */
export type StackTask = Pick<ManifestTask, "dependsOn" | "id" | "parent">;

/** What `worktreesOf` reads from each task a manifest already has. */
export type CheckedOut = Pick<ManifestTask, "dependsOn" | "id" | "worktree">;

/** A task and every task below it through parent links. It stops at a task it does not know or one it has seen. */
export const lineOf = (
  parents: Record.ReadonlyRecord<string, TaskId | null>,
  id: TaskId,
): ReadonlyArray<TaskId> =>
  Array.unfold({ next: Option.some(id), seen: HashSet.empty<TaskId>() }, ({ next, seen }) =>
    pipe(
      next,
      Option.filter((at) => !HashSet.has(seen, at)),
      Option.map(
        (at) =>
          [
            at,
            {
              next: Option.flatMap(Record.get(parents, at), (parent) => Option.fromNullOr(parent)),
              seen: HashSet.add(seen, at),
            },
          ] as const,
      ),
    ),
  );

/**
 * The parent a task's dependencies give it. When they all lie on one chain of parent links it is
 * the latest of them, the one with every other below it. With no dependencies, or with
 * dependencies on different stacks, there is none: the task starts from the base branch, after
 * those dependencies land. `tasks` gives the parent of every task the dependencies may name.
 */
export const parentOf = (
  dependsOn: ReadonlyArray<TaskId>,
  tasks: ReadonlyArray<StackLink>,
): Option.Option<TaskId> => {
  const parents = Record.fromEntries(Array.map(tasks, (task) => [task.id, task.parent] as const));
  return Array.findFirst(dependsOn, (latest) => {
    const line = lineOf(parents, latest);
    return Array.every(dependsOn, (dependency) => Array.contains(line, dependency));
  });
};

/**
 * The parent `stackOf` gives a task: `parentOf` over `stackedOn`. A gated task takes none when the
 * chain below that parent holds a task it does not need, which a conflict ordering from an earlier
 * plan can put there. It then starts from the base branch once its dependencies land, so nothing
 * sits below a gate but what it needs (`prd.human-gates`). `needs` says whether the task needs
 * another, directly or through other tasks.
 */
export const placedOn = (
  task: Pick<ManifestTask, "dependsOn" | "humanGate" | "orderedAfter">,
  tasks: ReadonlyArray<StackLink>,
  needs: (other: TaskId) => boolean,
): Option.Option<TaskId> => {
  const parent = parentOf(stackedOn(task), tasks);
  const parents = Record.fromEntries(Array.map(tasks, (link) => [link.id, link.parent] as const));
  return task.humanGate.required
    ? Option.filter(parent, (on) => Array.every(lineOf(parents, on), needs))
    : parent;
};

/** Worktree 0 is the repo's own checkout; the rest are `wt-1`, `wt-2`, .... */
const worktreeName = (slot: number): string | null => (slot === 0 ? null : `wt-${slot}`);

/** The slot a worktree name stands for. A name `worktreeName` does not give has none. */
const slotOf = (worktree: string | null): Option.Option<number> =>
  Option.match(Option.fromNullOr(worktree), {
    onNone: () => Option.some(0),
    onSome: (name) =>
      pipe(
        name,
        String.match(/^wt-([1-9]\d*)$/u),
        Option.flatMap(Array.get(1)),
        Option.flatMap(Number.parse),
      ),
  });

interface Checkouts {
  /** The latest task in each worktree, by name. */
  readonly latest: HashMap.HashMap<string | null, TaskId>;
  /** Every task given each worktree so far, by name. */
  readonly members: HashMap.HashMap<string | null, ReadonlyArray<TaskId>>;
  /** The worktree each task so far was given. */
  readonly worktreeOf: Record.ReadonlyRecord<string, string | null>;
  /** The slot of the next new worktree: one above every slot taken so far. */
  readonly next: number;
}

const checkOut = (checkouts: Checkouts, id: TaskId, worktree: string | null): Checkouts => ({
  latest: HashMap.set(checkouts.latest, worktree, id),
  members: HashMap.set(
    checkouts.members,
    worktree,
    Array.append(
      Option.getOrElse(HashMap.get(checkouts.members, worktree), Array.empty<TaskId>),
      id,
    ),
  ),
  next: Option.match(slotOf(worktree), {
    onNone: () => checkouts.next,
    onSome: (slot) => Number.max(checkouts.next, slot + 1),
  }),
  worktreeOf: Record.set(checkouts.worktreeOf, id, worktree),
});

/** Every task `id` depends on, directly or through the tasks it depends on. */
const closureOf = (
  needs: Record.ReadonlyRecord<string, ReadonlyArray<TaskId>>,
  id: TaskId,
): HashSet.HashSet<TaskId> => {
  const direct = (of: TaskId) => Option.getOrElse(Record.get(needs, of), Array.empty<TaskId>);
  let seen = HashSet.empty<TaskId>();
  let todo = direct(id);
  // loop: walks the dependency graph with a work list until no unseen task is left
  while (Array.isReadonlyArrayNonEmpty(todo)) {
    const [next, ...rest] = todo;
    todo = HashSet.has(seen, next) ? rest : Array.appendAll(rest, direct(next));
    seen = HashSet.add(seen, next);
  }
  return seen;
};

/**
 * A worktree for each task, walking them in the order given after the tasks `existing` already
 * has, which keep theirs. A task takes the worktree of its parent, or else of one of its
 * dependencies, latest first, when that worktree's latest task is one it depends on and it
 * depends, directly or not, on every task the worktree has had. A manifest edited by hand can list
 * a worktree's tasks out of dependency order, so its latest task alone does not say that.
 * Otherwise a task gets a new worktree, above every `wt-` worktree `existing` uses. So tasks
 * that share a worktree run one after another, and tasks that can run at the same time never
 * share one.
 */
export const worktreesOf = (
  tasks: ReadonlyArray<StackTask>,
  existing: ReadonlyArray<CheckedOut> = [],
): ReadonlyArray<string | null> => {
  const positions = Record.fromEntries(
    Array.map(Array.appendAll(existing, tasks), (task, at) => [task.id, at] as const),
  );
  const latestFirst = Order.flip(
    Order.mapInput(Order.Number, (id: TaskId) =>
      Option.getOrElse(Record.get(positions, id), () => -1),
    ),
  );
  const needs = Record.fromEntries(
    Array.map(Array.appendAll(existing, tasks), (task) => [task.id, task.dependsOn] as const),
  );
  const none: Checkouts = {
    latest: HashMap.empty(),
    members: HashMap.empty(),
    next: 0,
    worktreeOf: {},
  };
  const start = Array.reduce(existing, none, (checkouts, task) =>
    checkOut(checkouts, task.id, task.worktree),
  );
  return Array.mapAccum(tasks, start, (checkouts, task) => {
    const candidates = Array.appendAll(
      Option.toArray(Option.fromNullOr(task.parent)),
      Array.sort(task.dependsOn, latestFirst),
    );
    const below = closureOf(needs, task.id);
    const reusable = Array.findFirst(candidates, (candidate) =>
      Option.filter(
        Record.get(checkouts.worktreeOf, candidate),
        (worktree) =>
          Option.exists(HashMap.get(checkouts.latest, worktree), (latest) =>
            Array.contains(task.dependsOn, latest),
          ) &&
          Array.every(
            Option.getOrElse(HashMap.get(checkouts.members, worktree), Array.empty<TaskId>),
            (member) => HashSet.has(below, member),
          ),
      ),
    );
    const worktree = Option.getOrElse(reusable, () => worktreeName(checkouts.next));
    return [checkOut(checkouts, task.id, worktree), worktree];
  })[1];
};

/**
 * A draft with its gate, the positions in the planner's list of the drafts it depends on, and the
 * tasks the manifest already has that it depends on.
 */
interface Node {
  readonly after: ReadonlyArray<TaskId>;
  readonly draft: TaskDraft;
  readonly gate: HumanGate;
  readonly index: number;
  readonly needs: ReadonlyArray<number>;
}

const refuse = (problem: StackProblem, titles: readonly [string, ...string[]]) =>
  Result.fail(new StackOrderError({ problem, titles }));

/** The drafts, unless two share a title: a draft names what it depends on by title. */
const uniqueTitles = (
  drafts: ReadonlyArray<TaskDraft>,
): Result.Result<ReadonlyArray<TaskDraft>, StackOrderError> =>
  Option.match(
    Array.findFirst(Record.values(Array.groupBy(drafts, (draft) => draft.title)), (group) =>
      Option.map(Array.get(group, 1), (second) => second.title),
    ),
    { onNone: () => Result.succeed(drafts), onSome: (title) => refuse("duplicate-title", [title]) },
  );

/**
 * Each draft as a node. A dependency is the title of a draft or, failing that, the ID of a task in
 * `existing`.
 */
const nodesOf = (
  drafts: ReadonlyArray<TaskDraft>,
  gates: (draft: TaskDraft) => HumanGate,
  existing: ReadonlyArray<ManifestTask>,
): Result.Result<ReadonlyArray<Node>, StackOrderError> => {
  const indexOf = Record.fromEntries(
    Array.map(drafts, (draft, index) => [draft.title, index] as const),
  );
  const idOf: Record.ReadonlyRecord<string, TaskId> = Record.fromEntries(
    Array.map(existing, (task) => [task.id, task.id] as const),
  );
  const nodeOf = (draft: TaskDraft, index: number) => {
    const dependsOn = Array.dedupe(draft.dependsOn);
    const outside = Array.filter(dependsOn, (title) => !Record.has(indexOf, title));
    return Option.match(
      Array.findFirst(outside, (title) => !Record.has(idOf, title)),
      {
        onNone: () =>
          Result.succeed({
            after: Array.getSomes(Array.map(outside, (id) => Record.get(idOf, id))),
            draft,
            gate: gates(draft),
            index,
            needs: Array.getSomes(Array.map(dependsOn, (title) => Record.get(indexOf, title))),
          }),
        onSome: (title) => refuse("unknown-dependency", [draft.title, title]),
      },
    );
  };
  return Result.all(Array.map(drafts, nodeOf));
};

/**
 * The drafts in build order. Of the drafts whose dependencies are placed, a gated one goes first,
 * then the planner's order. A cycle leaves its drafts, and every draft that waits on them, out.
 */
const orderOf = (nodes: ReadonlyArray<Node>): ReadonlyArray<Node> =>
  Array.unfold(HashSet.empty<number>(), (placed) => {
    const ready = (node: Node) =>
      !HashSet.has(placed, node.index) &&
      Array.every(node.needs, (need) => HashSet.has(placed, need));
    return pipe(
      Array.findFirst(nodes, (node) => node.gate.required && ready(node)),
      Option.orElse(() => Array.findFirst(nodes, ready)),
      Option.map((node) => [node, HashSet.add(placed, node.index)] as const),
    );
  });

/**
 * A cycle among drafts that could not be placed, in order: each depends on the next and the last
 * on the first. Every such draft waits on another one, so following the waits from any of them
 * comes back to a draft already on the path.
 */
const cycleOf = (waiting: Array.NonEmptyReadonlyArray<Node>): Array.NonEmptyReadonlyArray<Node> => {
  const waitsOn = (node: Node): Option.Option<Node> =>
    Array.findFirst(node.needs, (need) =>
      Array.findFirst(waiting, (other) => other.index === need),
    );
  const walk = (path: Array.NonEmptyReadonlyArray<Node>): Array.NonEmptyReadonlyArray<Node> =>
    Option.match(waitsOn(Array.lastNonEmpty(path)), {
      // Not reached: a draft that could not be placed waits on another that could not.
      onNone: () => path,
      onSome: (next) =>
        Option.match(
          Array.findFirstIndex(path, (node) => node.index === next.index),
          {
            onNone: () => walk(Array.append(path, next)),
            onSome: (at) => Array.prepend(Array.drop(path, at + 1), next),
          },
        ),
    });
  return walk([Array.headNonEmpty(waiting)]);
};

/** A draft placed in build order, with its ID, dependencies, orderings and parent. */
interface Placement extends StackTask {
  readonly node: Node;
  readonly orderedAfter: ReadonlyArray<OrderedAfter>;
  readonly position: number;
}

interface Placed {
  readonly links: ReadonlyArray<StackLink>;
  /** The ID each draft was given, by its index in the planner's list. */
  readonly ids: HashMap.HashMap<number, TaskId>;
  /** Where each task so far sits in the manifest, by ID. */
  readonly rank: Record.ReadonlyRecord<string, number>;
  /** What each task so far needs, directly or through other tasks, by ID. */
  readonly needs: Record.ReadonlyRecord<string, HashSet.HashSet<TaskId>>;
}

/** `seen` and every task `pending` names, with what each needs through `dependsOn`, in any order. */
const neededFrom = (
  dependsOn: (id: TaskId) => ReadonlyArray<TaskId>,
  pending: ReadonlyArray<TaskId>,
  seen: HashSet.HashSet<TaskId>,
): HashSet.HashSet<TaskId> =>
  Array.match(pending, {
    onEmpty: () => seen,
    onNonEmpty: ([next, ...rest]) =>
      HashSet.has(seen, next)
        ? neededFrom(dependsOn, rest, seen)
        : neededFrom(dependsOn, Array.appendAll(rest, dependsOn(next)), HashSet.add(seen, next)),
  });

/** `needs` with `id`'s: its dependencies and everything they need. */
const withNeeds = (
  needs: Record.ReadonlyRecord<string, HashSet.HashSet<TaskId>>,
  id: TaskId,
  dependsOn: ReadonlyArray<TaskId>,
): Record.ReadonlyRecord<string, HashSet.HashSet<TaskId>> =>
  Record.set(
    needs,
    id,
    Array.reduce(dependsOn, HashSet.fromIterable(dependsOn), (all, dependency) =>
      HashSet.union(
        all,
        Option.getOrElse(Record.get(needs, dependency), () => HashSet.empty()),
      ),
    ),
  );

/** The number in a task ID of the form `t<number>`. An ID of another form has none. */
const numberOf = (id: TaskId): Option.Option<number> =>
  pipe(id, String.match(/^t(\d+)$/u), Option.flatMap(Array.get(1)), Option.flatMap(Number.parse));

/**
 * The drafts placed after `existing`, in order. Their IDs continue from the highest number an
 * existing ID has, and their dependencies are listed in manifest order. Each takes the orderings
 * whose `task` is its ID, and its parent from its dependencies and those orderings.
 */
const placementsOf = (
  order: ReadonlyArray<Node>,
  existing: ReadonlyArray<ManifestTask>,
  orderings: ReadonlyArray<Ordering>,
): ReadonlyArray<Placement> => {
  const highest = Array.reduce(
    Array.getSomes(Array.map(existing, (task) => numberOf(task.id))),
    0,
    (most, number) => Number.max(most, number),
  );
  const existingDependsOn = Record.fromEntries(
    Array.map(existing, (task) => [task.id, task.dependsOn] as const),
  );
  const dependsOnOf = (id: TaskId) =>
    Option.getOrElse(Record.get(existingDependsOn, id), (): ReadonlyArray<TaskId> => []);
  const start: Placed = {
    ids: HashMap.empty(),
    links: existing,
    // Read from the whole graph, since a manifest need not list a task after what it needs.
    needs: Record.fromEntries(
      Array.map(
        existing,
        (task) => [task.id, neededFrom(dependsOnOf, task.dependsOn, HashSet.empty())] as const,
      ),
    ),
    rank: Record.fromEntries(Array.map(existing, (task, at) => [task.id, at] as const)),
  };
  return Array.mapAccum(order, start, (placed, node, at) => {
    const position = highest + at + 1;
    const id = TaskId.make(`t${position}`);
    const dependsOn = Array.sort(
      Array.appendAll(
        node.after,
        Array.getSomes(Array.map(node.needs, (need) => HashMap.get(placed.ids, need))),
      ),
      Order.mapInput(Order.Number, (dependency: TaskId) =>
        Option.getOrElse(Record.get(placed.rank, dependency), () => -1),
      ),
    );
    const orderedAfter = Array.filterMap(orderings, ({ after, reason, task }) =>
      task === id ? Result.succeed({ reason, task: after }) : Result.failVoid,
    );
    const needs = withNeeds(placed.needs, id, dependsOn);
    const needed = Option.getOrElse(Record.get(needs, id), () => HashSet.empty<TaskId>());
    const parent = Option.getOrNull(
      placedOn({ dependsOn, humanGate: node.gate, orderedAfter }, placed.links, (other) =>
        HashSet.has(needed, other),
      ),
    );
    return [
      {
        ids: HashMap.set(placed.ids, node.index, id),
        links: Array.append(placed.links, { id, parent }),
        needs,
        rank: Record.set(placed.rank, id, Array.length(existing) + at),
      },
      { dependsOn, id, node, orderedAfter, parent, position },
    ];
  })[1];
};

/** A title as the last part of a branch name: its lowercase ASCII letters and digits, joined by `-`. */
const slugOf = (title: string): string =>
  pipe(
    title,
    String.toLowerCase,
    String.replaceAll(/[^a-z0-9]+/gu, "-"),
    String.replaceAll(/^-|-$/gu, ""),
    Option.liftPredicate(String.isNonEmpty),
    Option.getOrElse(() => "task"),
  );

const taskOf = (feature: Slug, placement: Placement, worktree: string | null): ManifestTask => {
  const { draft, gate } = placement.node;
  return {
    branch: `${feature}/${String.padStart(2, "0")(`${placement.position}`)}-${slugOf(draft.title)}`,
    category: draft.category,
    commits: [],
    dependsOn: placement.dependsOn,
    files: draft.files,
    humanGate: gate,
    id: placement.id,
    model: draft.model,
    orderedAfter: placement.orderedAfter,
    parent: placement.parent,
    prdSections: draft.prdSections,
    reasoning: draft.reasoning,
    sessions: [],
    specSections: draft.specSections,
    status: "pending",
    title: draft.title,
    worktree,
  };
};

/**
 * Orders drafts into a set of stacks after the tasks `existing` already has (see
 * `spec.planning.stack-order`), and returns those tasks as they are, then the new ones. On a first
 * plan `existing` is empty. New IDs continue from the highest existing `t<number>` ID, `t1` on a
 * first plan, in dependency order, taking a gated draft first among those whose dependencies are
 * placed, then the planner's order. A draft depends on other drafts by title and on existing
 * tasks by ID. Each new task gets its branch, its dependencies as IDs, the parent `placedOn`
 * gives and the worktree `worktreesOf` gives; either may be an existing task's. `gates` is the
 * plan-time gate of each draft. Two drafts with one title, a dependency that is neither a draft's
 * title nor an existing ID, and a cycle are a `StackOrderError`.
 *
 * `orderings` are the conflict orderings to apply (see `spec.planning.conflict-ordering`): a new
 * task an ordering names gains it in `orderedAfter`, and its parent comes from `dependsOn` plus
 * `orderedAfter`. An ordering leaves the order and the IDs as they are, since it only stacks a
 * task on one with a lower ID, and an ordering of an existing task is ignored.
 */
export const stackOf = (
  feature: Slug,
  drafts: ReadonlyArray<TaskDraft>,
  gates: (draft: TaskDraft) => HumanGate,
  existing: ReadonlyArray<ManifestTask> = [],
  orderings: ReadonlyArray<Ordering> = [],
): Result.Result<ReadonlyArray<ManifestTask>, StackOrderError> =>
  Result.gen(function* () {
    const nodes = yield* Result.flatMap(uniqueTitles(drafts), (unique) =>
      nodesOf(unique, gates, existing),
    );
    const order = orderOf(nodes);
    const placed = HashSet.fromIterable(Array.map(order, (node) => node.index));
    const waiting = Array.filter(nodes, (node) => !HashSet.has(placed, node.index));
    if (Array.isReadonlyArrayNonEmpty(waiting)) {
      return yield* refuse(
        "cycle",
        Array.map(cycleOf(waiting), (node) => node.draft.title),
      );
    }
    const placements = placementsOf(order, existing, orderings);
    return Array.appendAll(
      existing,
      Array.zipWith(placements, worktreesOf(placements, existing), (placement, worktree) =>
        taskOf(feature, placement, worktree),
      ),
    );
  });
