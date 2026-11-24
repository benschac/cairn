import { TaskId } from "@cairn/contract";
import type { HumanGate, ManifestTask, Slug, TaskDraft } from "@cairn/contract";
import {
  Array,
  HashMap,
  HashSet,
  Match,
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
 * draft and the title it depends on that no draft has; or the drafts of a cycle in order, each
 * depending on the next and the last on the first.
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
        () => `${Array.join(quoted, " depends on ")}, which is the title of no draft.`,
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

/** What `parentOf` reads from each task placed so far. */
export type StackLink = Pick<ManifestTask, "id" | "parent">;

/** What `worktreesOf` reads from each task. */
export type StackTask = Pick<ManifestTask, "dependsOn" | "id" | "parent">;

/** A task and every task below it through parent links. It stops at a task it does not know or one it has seen. */
const lineOf = (
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

/** Worktree 0 is the repo's own checkout; the rest are `wt-1`, `wt-2`, .... */
const worktreeName = (slot: number): string | null => (slot === 0 ? null : `wt-${slot}`);

interface Checkouts {
  /** The latest task in each worktree, by slot. */
  readonly latest: ReadonlyArray<TaskId>;
  /** The slot each task so far was given. */
  readonly slotOf: Record.ReadonlyRecord<string, number>;
}

/**
 * A worktree for each task, walking them in the order given. A task takes the worktree of its
 * parent, or else of one of its dependencies, latest first, when that worktree's latest task is
 * one it depends on. Otherwise it gets a new one. So tasks that share a worktree run one after
 * another, and tasks that can run at the same time never share one.
 */
export const worktreesOf = (tasks: ReadonlyArray<StackTask>): ReadonlyArray<string | null> => {
  const positions = Record.fromEntries(Array.map(tasks, (task, at) => [task.id, at] as const));
  const latestFirst = Order.flip(
    Order.mapInput(Order.Number, (id: TaskId) =>
      Option.getOrElse(Record.get(positions, id), () => -1),
    ),
  );
  const start: Checkouts = { latest: [], slotOf: {} };
  return Array.mapAccum(tasks, start, (checkouts, task) => {
    const candidates = Array.appendAll(
      Option.toArray(Option.fromNullOr(task.parent)),
      Array.sort(task.dependsOn, latestFirst),
    );
    const reusable = Array.findFirst(candidates, (candidate) =>
      Option.filter(Record.get(checkouts.slotOf, candidate), (slot) =>
        Option.exists(Array.get(checkouts.latest, slot), (latest) =>
          Array.contains(task.dependsOn, latest),
        ),
      ),
    );
    const slot = Option.getOrElse(reusable, () => Array.length(checkouts.latest));
    const latest = Option.match(reusable, {
      onNone: () => Array.append(checkouts.latest, task.id),
      onSome: (taken) =>
        Option.getOrElse(Array.replace(checkouts.latest, taken, task.id), () => checkouts.latest),
    });
    return [{ latest, slotOf: Record.set(checkouts.slotOf, task.id, slot) }, worktreeName(slot)];
  })[1];
};

/** A draft with its gate and the positions in the planner's list of the drafts it depends on. */
interface Node {
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

const nodesOf = (
  drafts: ReadonlyArray<TaskDraft>,
  gates: (draft: TaskDraft) => HumanGate,
): Result.Result<ReadonlyArray<Node>, StackOrderError> => {
  const indexOf = Record.fromEntries(
    Array.map(drafts, (draft, index) => [draft.title, index] as const),
  );
  const needOf = (draft: TaskDraft) => (title: string) =>
    Option.match(Record.get(indexOf, title), {
      onNone: () => refuse("unknown-dependency", [draft.title, title]),
      onSome: (index) => Result.succeed(index),
    });
  return Result.all(
    Array.map(drafts, (draft, index) =>
      Result.map(Result.all(Array.map(Array.dedupe(draft.dependsOn), needOf(draft))), (needs) => ({
        draft,
        gate: gates(draft),
        index,
        needs,
      })),
    ),
  );
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

/** A draft placed in build order, with its ID, dependencies and parent. */
interface Placement extends StackTask {
  readonly node: Node;
  readonly position: number;
}

interface Placed {
  readonly links: ReadonlyArray<StackLink>;
  /** The 1-based position each draft was placed at, by its index in the planner's list. */
  readonly positions: HashMap.HashMap<number, number>;
}

const idAt = (position: number): TaskId => TaskId.make(`t${position}`);

const placementsOf = (order: ReadonlyArray<Node>): ReadonlyArray<Placement> => {
  const start: Placed = { links: [], positions: HashMap.empty() };
  return Array.mapAccum(order, start, (placed, node, at) => {
    const position = at + 1;
    const id = idAt(position);
    const dependsOn = Array.map(
      Array.sort(
        Array.getSomes(Array.map(node.needs, (need) => HashMap.get(placed.positions, need))),
        Order.Number,
      ),
      idAt,
    );
    const parent = Option.getOrNull(parentOf(dependsOn, placed.links));
    return [
      {
        links: Array.append(placed.links, { id, parent }),
        positions: HashMap.set(placed.positions, node.index, position),
      },
      { dependsOn, id, node, parent, position },
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
    commits: [],
    dependsOn: placement.dependsOn,
    files: draft.files,
    humanGate: gate,
    id: placement.id,
    model: draft.model,
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
 * Orders a first plan's drafts into a set of stacks (see `spec.planning.stack-order`). IDs are
 * `t1`, `t2`, ... in dependency order, taking a gated draft first among those whose
 * dependencies are placed, then the planner's order. Each task gets its branch, its dependencies
 * as IDs, the parent `parentOf` gives and the worktree `worktreesOf` gives. `gates` is the
 * plan-time gate of each draft. Two drafts with one title, a dependency on a title no draft has,
 * and a cycle are a `StackOrderError`.
 */
export const stackOf = (
  feature: Slug,
  drafts: ReadonlyArray<TaskDraft>,
  gates: (draft: TaskDraft) => HumanGate,
): Result.Result<ReadonlyArray<ManifestTask>, StackOrderError> =>
  Result.gen(function* () {
    const nodes = yield* Result.flatMap(uniqueTitles(drafts), (unique) => nodesOf(unique, gates));
    const order = orderOf(nodes);
    const placed = HashSet.fromIterable(Array.map(order, (node) => node.index));
    const waiting = Array.filter(nodes, (node) => !HashSet.has(placed, node.index));
    if (Array.isReadonlyArrayNonEmpty(waiting)) {
      return yield* refuse(
        "cycle",
        Array.map(cycleOf(waiting), (node) => node.draft.title),
      );
    }
    const placements = placementsOf(order);
    return Array.zipWith(placements, worktreesOf(placements), (placement, worktree) =>
      taskOf(feature, placement, worktree),
    );
  });
