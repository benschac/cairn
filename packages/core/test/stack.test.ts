import { Manifest, ManifestTask, Slug, TaskDraft } from "@cairn/contract";
import type { HumanGate, TaskId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import {
  Array,
  HashSet,
  Number,
  Option,
  Order,
  Record,
  Result,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";

import { StackOrderError, stackOf } from "../src/index.ts";

const feature = Schema.decodeSync(Slug)("cairn-mvp");
const decodeDraft = Schema.decodeUnknownSync(TaskDraft);

const draftOf = (title: string, dependsOn: ReadonlyArray<string>): TaskDraft =>
  decodeDraft({
    category: "feature",
    dependsOn,
    files: [`packages/core/src/${title}.ts`],
    model: "sonnet",
    prdSections: ["prd.cli"],
    reasoning: "high",
    specSections: ["spec.planning.stack-order"],
    title,
  });

const gate = (required: boolean): HumanGate => ({
  reasons: required ? ["tag:human"] : [],
  required,
});

const NodeNumber = Schema.Int.check(Schema.isBetween({ maximum: 11, minimum: 0 }));

/**
 * A plan as the planner might return it: node `n` is the `n`th element. It depends on the nodes
 * in `needs` that are below `n`, so there is no cycle. The planner lists the nodes sorted by
 * `key`, which need not be a build order.
 */
const Plan = Schema.Array(
  Schema.Struct({
    gated: Schema.Boolean,
    key: Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 })),
    needs: Schema.Array(NodeNumber).check(Schema.isMaxLength(4)),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(12));
type Plan = typeof Plan.Type;

/** The planner's order of the nodes. */
const orderOf = (plan: Plan): ReadonlyArray<number> =>
  Array.sort(
    Array.range(0, Array.length(plan) - 1),
    Order.mapInput(Order.Number, (node: number) =>
      Option.getOrElse(
        Option.map(Array.get(plan, node), ({ key }) => key),
        () => 0,
      ),
    ),
  );

/** A node of the plan, given as any number: it wraps around. */
const nodeIn = (plan: Plan, number: number): number => number % Array.length(plan);

const titleOf = (node: number): string => `Build part ${node}`;

const needsOf = (plan: Plan, node: number): ReadonlyArray<number> =>
  pipe(
    Array.get(plan, node),
    Option.match({ onNone: (): ReadonlyArray<number> => [], onSome: ({ needs }) => needs }),
    Array.filter((need) => need < node),
    Array.dedupe,
  );

/** The plan's drafts in the planner's order; `extra` adds dependencies by title. */
const draftsOf = (
  plan: Plan,
  extra: (node: number) => ReadonlyArray<string> = () => [],
): ReadonlyArray<TaskDraft> =>
  Array.map(orderOf(plan), (node) =>
    draftOf(titleOf(node), Array.appendAll(Array.map(needsOf(plan, node), titleOf), extra(node))),
  );

const gatesOf = (plan: Plan) => {
  const gatedByTitle = Record.fromEntries(
    Array.map(plan, ({ gated }, node) => [titleOf(node), gated] as const),
  );
  return (draft: TaskDraft): HumanGate =>
    gate(Option.getOrElse(Record.get(gatedByTitle, draft.title), () => false));
};

const stacked = (plan: Plan): ReadonlyArray<ManifestTask> =>
  Result.getOrThrow(stackOf(feature, draftsOf(plan), gatesOf(plan)));

const failureOf = <A>(result: Result.Result<A, StackOrderError>) =>
  Option.getOrThrow(
    Result.match(result, { onFailure: Option.some, onSuccess: () => Option.none() }),
  );

const byId = (tasks: ReadonlyArray<ManifestTask>) =>
  Record.fromEntries(Array.map(tasks, (task, at) => [task.id, { at, task }] as const));
type ById = ReturnType<typeof byId>;

const positionOf = (index: ById, id: TaskId): number =>
  Option.getOrThrow(Option.map(Record.get(index, id), ({ at }) => at));

/** The tasks below a task through parent links, nearest first. */
const ancestorsOf = (index: ById, id: TaskId): ReadonlyArray<TaskId> =>
  pipe(
    Record.get(index, id),
    Option.flatMap(({ task }) => Option.fromNullOr(task.parent)),
    Option.match({
      onNone: () => [],
      onSome: (parent) => Array.prepend(ancestorsOf(index, parent), parent),
    }),
  );

/**
 * Everything a task depends on, directly or through other tasks. `seen` stops it at a task it has
 * reached already, so a generated manifest whose tasks depend on each other in a cycle ends.
 */
const closureOf = (
  index: ById,
  id: TaskId,
  seen: HashSet.HashSet<TaskId> = HashSet.empty(),
): HashSet.HashSet<TaskId> =>
  Array.reduce(
    Option.match(Record.get(index, id), { onNone: () => [], onSome: ({ task }) => task.dependsOn }),
    seen,
    (all, dependency) =>
      HashSet.has(all, dependency)
        ? all
        : closureOf(index, dependency, HashSet.add(all, dependency)),
  );

/** The last task before position `at` that was built in `worktree`. */
const latestBefore = (
  tasks: ReadonlyArray<ManifestTask>,
  at: number,
  worktree: string | null,
): Option.Option<ManifestTask> =>
  Array.findLast(Array.take(tasks, at), (task) => task.worktree === worktree);

const sorted = (titles: ReadonlyArray<string>) => Array.sort(titles, String.Order);

it.prop(
  "every draft becomes one task with its own fields, and the tasks make a manifest",
  [Plan],
  ([plan]) => {
    const drafts = draftsOf(plan);
    const tasks = stacked(plan);
    expect(Schema.is(Manifest)({ baseBranch: "main", feature, tasks, version: 1 })).toBe(true);
    expect(Array.map(tasks, (task) => task.id)).toEqual(
      Array.makeBy(Array.length(drafts), (at) => `t${at + 1}`),
    );
    expect(sorted(Array.map(tasks, (task) => task.title))).toEqual(
      sorted(Array.map(drafts, (draft) => draft.title)),
    );
    const fields = ["files", "model", "prdSections", "reasoning", "specSections", "title"] as const;
    Array.forEach(tasks, (task) => {
      const draft = Option.getOrThrow(Array.findFirst(drafts, (one) => one.title === task.title));
      expect(Struct.pick(task, fields)).toEqual(Struct.pick(draft, fields));
      expect(task.humanGate).toEqual(gatesOf(plan)(draft));
      expect([task.status, task.commits, task.sessions]).toEqual(["pending", [], []]);
    });
  },
);

it.prop(
  "a branch is the feature, the ID's number in at least two digits, and the title in kebab case",
  [Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1), Schema.isMaxLength(12))],
  ([titles]) => {
    const tasks = Result.getOrThrow(
      stackOf(
        feature,
        Array.map(Array.dedupe(titles), (title) => draftOf(title, [])),
        () => gate(false),
      ),
    );
    Array.forEach(tasks, (task, at) => {
      expect(Schema.is(ManifestTask)(task)).toBe(true);
      const number = String.padStart(2, "0")(`${at + 1}`);
      expect(task.branch).toMatch(
        new RegExp(`^cairn-mvp/${number}-[a-z0-9]+(?:-[a-z0-9]+)*$`, "u"),
      );
    });
  },
);

it.prop(
  "a task depends on its draft's dependencies by ID, and comes after all of them",
  [Plan],
  ([plan]) => {
    const drafts = draftsOf(plan);
    const tasks = stacked(plan);
    const index = byId(tasks);
    Array.forEach(tasks, (task, at) => {
      const draft = Option.getOrThrow(Array.findFirst(drafts, (one) => one.title === task.title));
      const titles = Array.map(task.dependsOn, (id) =>
        Option.getOrThrow(Option.map(Record.get(index, id), (entry) => entry.task.title)),
      );
      expect(sorted(titles)).toEqual(sorted(draft.dependsOn));
      expect(Array.every(task.dependsOn, (id) => positionOf(index, id) < at)).toBe(true);
    });
  },
);

it.prop(
  "of the drafts that could go next, a gated one goes first, then the planner's order",
  [Plan],
  ([plan]) => {
    const drafts = draftsOf(plan);
    const tasks = stacked(plan);
    const index = byId(tasks);
    const size = Array.length(drafts);
    const rank = (task: ManifestTask) =>
      (task.humanGate.required ? 0 : size) +
      Option.getOrThrow(Array.findFirstIndex(drafts, (draft) => draft.title === task.title));
    const couldGoAt = (task: ManifestTask, at: number) =>
      Array.every(task.dependsOn, (id) => positionOf(index, id) < at);
    const overtaken = Array.flatMap(tasks, (task, at) =>
      Array.filterMap(Array.drop(tasks, at + 1), (later) =>
        couldGoAt(later, at) && rank(later) < rank(task)
          ? Result.succeed([task.id, later.id])
          : Result.failVoid,
      ),
    );
    expect(overtaken).toEqual([]);
  },
);

it.prop(
  "a parent is the latest dependency when the dependencies lie on one chain, and none otherwise",
  [Plan],
  ([plan]) => {
    const tasks = stacked(plan);
    const index = byId(tasks);
    const holdsAll = (id: TaskId, task: ManifestTask) =>
      Array.every(task.dependsOn, (dependency) =>
        Array.contains(Array.prepend(ancestorsOf(index, id), id), dependency),
      );
    Array.forEach(tasks, (task) => {
      Option.match(Option.fromNullOr(task.parent), {
        onNone: () => expect(Array.some(task.dependsOn, (id) => holdsAll(id, task))).toBe(false),
        onSome: (parent) => {
          expect(Array.contains(task.dependsOn, parent)).toBe(true);
          expect(holdsAll(parent, task)).toBe(true);
        },
      });
    });
  },
);

it.prop("nothing sits below a task except what it depends on", [Plan], ([plan]) => {
  const tasks = stacked(plan);
  const index = byId(tasks);
  const strays = Array.flatMap(tasks, (task) =>
    Array.filter(ancestorsOf(index, task.id), (id) => !HashSet.has(closureOf(index, task.id), id)),
  );
  expect(strays).toEqual([]);
});

it.prop(
  "tasks that share a worktree run one after another, never at the same time",
  [Plan],
  ([plan]) => {
    const tasks = stacked(plan);
    const index = byId(tasks);
    const clashes = Array.flatMap(tasks, (task, at) =>
      Array.filterMap(Array.take(tasks, at), (earlier) =>
        earlier.worktree === task.worktree && !HashSet.has(closureOf(index, task.id), earlier.id)
          ? Result.succeed([earlier.id, task.id])
          : Result.failVoid,
      ),
    );
    expect(clashes).toEqual([]);
  },
);

it.prop(
  "the first worktree is the repo's own checkout and the next are wt-1, wt-2, ...",
  [Plan],
  ([plan]) => {
    const used = Array.dedupe(Array.map(stacked(plan), (task) => task.worktree));
    expect(used).toEqual(Array.map(used, (_, slot) => (slot === 0 ? null : `wt-${slot}`)));
  },
);

it.prop(
  "a task continues a worktree whose latest task it depends on, and opens one only when it cannot",
  [Plan],
  ([plan]) => {
    const tasks = stacked(plan);
    const index = byId(tasks);
    const worktreeOf = (id: TaskId) =>
      Option.getOrThrow(Option.map(Record.get(index, id), ({ task }) => task.worktree));
    const continues = (task: ManifestTask, at: number, worktree: string | null) =>
      Option.exists(latestBefore(tasks, at, worktree), (latest) =>
        Array.contains(task.dependsOn, latest.id),
      );
    const wrong = Array.filterMap(tasks, (task, at) => {
      const right = Option.match(latestBefore(tasks, at, task.worktree), {
        onNone: () => !Array.some(task.dependsOn, (id) => continues(task, at, worktreeOf(id))),
        onSome: (latest) =>
          Array.contains(task.dependsOn, latest.id) &&
          Option.match(Option.fromNullOr(task.parent), {
            onNone: () => true,
            onSome: (parent) =>
              !continues(task, at, worktreeOf(parent)) || task.worktree === worktreeOf(parent),
          }),
      });
      return right ? Result.failVoid : Result.succeed(task.id);
    });
    expect(wrong).toEqual([]);
  },
);

/** A plan and a ring of its nodes to join into a cycle, each depending on the next. */
const Cyclic = Schema.Struct({
  plan: Plan,
  ring: Schema.Array(NodeNumber).check(Schema.isMinLength(1)),
});

/** A plan and one of its nodes. */
const PlanAndNode = Schema.Struct({ node: NodeNumber, plan: Plan });

it.prop(
  "a cycle fails and names drafts that each depend on the next, the last on the first",
  [Cyclic],
  ([cyclic]) => {
    const { plan } = cyclic;
    const ring = Array.dedupe(Array.map(cyclic.ring, (number) => nodeIn(plan, number)));
    const next = (node: number) =>
      pipe(
        Array.findFirstIndex(ring, (member) => member === node),
        Option.flatMap((at) => Array.get(ring, (at + 1) % Array.length(ring))),
        Option.map(titleOf),
        Option.toArray,
      );
    const drafts = draftsOf(plan, next);
    const error = failureOf(stackOf(feature, drafts, gatesOf(plan)));
    expect(error.problem).toBe("cycle");
    expect(Array.dedupe(error.titles)).toEqual(error.titles);
    const dependsOn = (title: string) =>
      Option.getOrThrow(
        Option.map(
          Array.findFirst(drafts, (draft) => draft.title === title),
          (draft) => draft.dependsOn,
        ),
      );
    const links = Array.zip(
      error.titles,
      Array.append(Array.drop(error.titles, 1), Array.headNonEmpty(error.titles)),
    );
    expect(Array.every(links, ([title, needed]) => Array.contains(dependsOn(title), needed))).toBe(
      true,
    );
  },
);

it.prop(
  "a dependency on a title no draft has fails and names both",
  [PlanAndNode],
  ([{ node: picked, plan }]) => {
    const stray = nodeIn(plan, picked);
    const drafts = draftsOf(plan, (node) => (node === stray ? ["Not a draft"] : []));
    const error = failureOf(stackOf(feature, drafts, gatesOf(plan)));
    expect(Struct.pick(error, ["problem", "titles"])).toEqual({
      problem: "unknown-dependency",
      titles: [titleOf(stray), "Not a draft"],
    });
  },
);

it.prop("two drafts with one title fail and name it", [PlanAndNode], ([{ node: picked, plan }]) => {
  const twice = nodeIn(plan, picked);
  const drafts = Array.append(draftsOf(plan), draftOf(titleOf(twice), []));
  const error = failureOf(stackOf(feature, drafts, gatesOf(plan)));
  expect(Struct.pick(error, ["problem", "titles"])).toEqual({
    problem: "duplicate-title",
    titles: [titleOf(twice)],
  });
});

const shapeOf = (tasks: ReadonlyArray<ManifestTask>) =>
  Array.map(tasks, (task) => [task.id, task.title, task.parent, task.dependsOn, task.worktree]);

it("puts a gated draft first, stacks a chain, and starts a task that joins two stacks from main", () => {
  const drafts = [
    draftOf("Add the schema", []),
    draftOf("Add the service", ["Add the schema"]),
    draftOf("Add the command", ["Add the service", "Add the schema"]),
    draftOf("Add the migration", []),
    draftOf("Run the command on the store", ["Add the command", "Add the migration"]),
  ];
  const tasks = Result.getOrThrow(
    stackOf(feature, drafts, (draft) => gate(draft.title === "Add the migration")),
  );
  expect(shapeOf(tasks)).toEqual([
    ["t1", "Add the migration", null, [], null],
    ["t2", "Add the schema", null, [], "wt-1"],
    ["t3", "Add the service", "t2", ["t2"], "wt-1"],
    ["t4", "Add the command", "t3", ["t2", "t3"], "wt-1"],
    ["t5", "Run the command on the store", null, ["t1", "t4"], "wt-1"],
  ]);
  expect(Array.map(tasks, (task) => task.branch)).toEqual([
    "cairn-mvp/01-add-the-migration",
    "cairn-mvp/02-add-the-schema",
    "cairn-mvp/03-add-the-service",
    "cairn-mvp/04-add-the-command",
    "cairn-mvp/05-run-the-command-on-the-store",
  ]);
});

it("forks a stack, keeps one fork in its parent's worktree and gives the other a new one", () => {
  const drafts = [
    draftOf("Add the base", []),
    draftOf("Add the left side", ["Add the base"]),
    draftOf("Add the right side", ["Add the base"]),
    draftOf("Polish the left side", ["Add the left side", "Add the base"]),
    draftOf("Join both sides", ["Add the left side", "Add the right side"]),
  ];
  const tasks = Result.getOrThrow(stackOf(feature, drafts, () => gate(false)));
  expect(shapeOf(tasks)).toEqual([
    ["t1", "Add the base", null, [], null],
    ["t2", "Add the left side", "t1", ["t1"], null],
    ["t3", "Add the right side", "t1", ["t1"], "wt-1"],
    ["t4", "Polish the left side", "t2", ["t1", "t2"], null],
    ["t5", "Join both sides", null, ["t2", "t3"], "wt-1"],
  ]);
});

it("names a cycle in its message", () => {
  const error = failureOf(
    stackOf(feature, [draftOf("A", ["B"]), draftOf("B", ["A"]), draftOf("C", ["A"])], () =>
      gate(false),
    ),
  );
  expect(error.message).toBe(
    'Drafts depend on each other in a cycle: "A" depends on "B" depends on "A".',
  );
});

/** A plan and where to cut its first stack in two: the tasks below the cut are the manifest. */
const Cut = Schema.Struct({
  at: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 0 })),
  plan: Plan,
});

it.prop(
  "planning the tasks a manifest lacks after it gives what planning them all at once gives",
  [Cut],
  ([{ at, plan }]) => {
    const whole = stacked(plan);
    const existing = Array.take(whole, at % (Array.length(whole) + 1));
    const idOf = Record.fromEntries(Array.map(existing, (task) => [task.title, task.id] as const));
    const rest = Array.filterMap(draftsOf(plan), (draft) =>
      Record.has(idOf, draft.title)
        ? Result.failVoid
        : Result.succeed(
            Struct.evolve(draft, {
              dependsOn: (titles) =>
                Array.map(titles, (title) =>
                  Option.getOrElse(Record.get(idOf, title), () => title),
                ),
            }),
          ),
    );
    expect(Result.getOrThrow(stackOf(feature, rest, gatesOf(plan), existing))).toEqual(whole);
  },
);

/** The number of a `t<number>` ID. */
const numberOf = (id: TaskId): Option.Option<number> =>
  Option.flatMap(String.match(/^t(\d+)$/u)(id), (match) =>
    Option.flatMap(Array.get(match, 1), Number.parse),
  );

/**
 * A manifest of any tasks, a plan, and links from nodes of the plan to tasks of the manifest:
 * `node` and `task` wrap around.
 */
const Later = Schema.Struct({
  links: Schema.Array(Schema.Struct({ node: NodeNumber, task: NodeNumber })).check(
    Schema.isMaxLength(6),
  ),
  plan: Plan,
  tasks: Schema.Array(ManifestTask).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
});

it.prop(
  "drafts go after a manifest's tasks, which stay as they were, with higher IDs and their own worktrees",
  [Later],
  ([{ links, plan, tasks }]) => {
    const existing = Array.dedupeWith(tasks, (one, other) => one.id === other.id);
    const taskAt = (number: number) =>
      Option.getOrThrow(Array.get(existing, number % Array.length(existing)));
    const drafts = draftsOf(plan, (node) =>
      Array.filterMap(links, (link) =>
        nodeIn(plan, link.node) === node ? Result.succeed(taskAt(link.task).id) : Result.failVoid,
      ),
    );
    const all = Result.getOrThrow(stackOf(feature, drafts, gatesOf(plan), existing));
    const added = Array.drop(all, Array.length(existing));
    expect(Array.take(all, Array.length(existing))).toEqual(existing);
    expect(Array.length(added)).toBe(Array.length(drafts));
    expect(Array.every(added, (task) => Schema.is(ManifestTask)(task))).toBe(true);
    expect(Array.dedupe(Array.map(all, (task) => task.id))).toEqual(
      Array.map(all, (task) => task.id),
    );
    const highest = Array.reduce(
      Array.getSomes(Array.map(existing, (task) => numberOf(task.id))),
      0,
      (most, number) => Number.max(most, number),
    );
    expect(Array.map(added, (task) => task.id)).toEqual(
      Array.makeBy(Array.length(added), (at) => `t${highest + at + 1}`),
    );
    const addedId = Record.fromEntries(Array.map(added, (task) => [task.title, task.id] as const));
    Array.forEach(added, (task, at) => {
      const draft = Option.getOrThrow(Array.findFirst(drafts, (one) => one.title === task.title));
      const wanted = Array.map(Array.dedupe(draft.dependsOn), (dependency) =>
        Option.getOrElse(Record.get(addedId, dependency), () => dependency),
      );
      expect(sorted(task.dependsOn)).toEqual(sorted(wanted));
      expect(
        Array.every(Option.toArray(Option.fromNullOr(task.parent)), (parent) =>
          Array.contains(task.dependsOn, parent),
        ),
      ).toBe(true);
      const before = Array.take(all, Array.length(existing) + at);
      const latestIn = (worktree: string | null) =>
        Array.findLast(before, (earlier) => earlier.worktree === worktree);
      const below = closureOf(byId(all), task.id);
      // A worktree can be continued when its latest task is a dependency and every task it has had
      // is below this one, directly or not.
      const continuable = (worktree: string | null) =>
        Option.exists(latestIn(worktree), (latest) => Array.contains(task.dependsOn, latest.id)) &&
        Array.every(
          Array.filter(before, (earlier) => earlier.worktree === worktree),
          (earlier) => HashSet.has(below, earlier.id),
        );
      Option.match(latestIn(task.worktree), {
        onNone: () =>
          expect(
            Array.some(
              before,
              (earlier) =>
                Array.contains(task.dependsOn, earlier.id) && continuable(earlier.worktree),
            ),
          ).toBe(false),
        onSome: () => expect(continuable(task.worktree)).toBe(true),
      });
    });
  },
);

/** A task a manifest already has, as `stackOf` reads it. */
const existingOf = (
  id: string,
  title: string,
  parent: string | null,
  worktree: string | null,
  status: ManifestTask["status"],
): ManifestTask =>
  Schema.decodeSync(ManifestTask)({
    branch: `cairn-mvp/0${String.slice(1)(id)}-hand-named`,
    commits: status === "pending" ? [] : ["0123456789abcdef0123456789abcdef01234567"],
    dependsOn: Option.toArray(Option.fromNullOr(parent)),
    files: [`packages/core/src/${title}.ts`],
    humanGate: gate(false),
    id,
    model: "sonnet",
    parent,
    prdSections: ["prd.cli"],
    reasoning: "high",
    sessions: [],
    specSections: ["spec.planning.stack-order"],
    status,
    title,
    worktree,
  });

it("orders new drafts after a manifest's tasks and continues its IDs, stacks and worktrees", () => {
  const existing = [
    existingOf("t1", "Add the schema", null, null, "landed"),
    existingOf("t2", "Add the service", "t1", null, "running"),
    existingOf("t5", "Add the page", null, "wt-3", "pending"),
  ];
  const drafts = [
    draftOf("Wire the page", ["t5", "Add the command"]),
    draftOf("Add the command", ["t2", "t1"]),
    draftOf("Add the docs", []),
  ];
  const tasks = Result.getOrThrow(stackOf(feature, drafts, () => gate(false), existing));
  expect(Array.take(tasks, 3)).toEqual(existing);
  expect(shapeOf(Array.drop(tasks, 3))).toEqual([
    ["t6", "Add the command", "t2", ["t1", "t2"], null],
    ["t7", "Wire the page", null, ["t5", "t6"], null],
    ["t8", "Add the docs", null, [], "wt-4"],
  ]);
  expect(Array.map(Array.drop(tasks, 3), (task) => task.branch)).toEqual([
    "cairn-mvp/06-add-the-command",
    "cairn-mvp/07-wire-the-page",
    "cairn-mvp/08-add-the-docs",
  ]);
});

it("opens a new worktree when a manifest lists a worktree's tasks out of dependency order", () => {
  // t3 was built after t2 in wt-1 but is listed first, so t2 looks like wt-1's latest task.
  const existing = [
    existingOf("t3", "Add the status", "t2", "wt-1", "landed"),
    existingOf("t2", "Land from git", null, "wt-1", "landed"),
  ];
  const tasks = Result.getOrThrow(
    stackOf(feature, [draftOf("Read the trailers", ["t2"])], () => gate(false), existing),
  );
  expect(shapeOf(Array.drop(tasks, 2))).toEqual([
    ["t4", "Read the trailers", "t2", ["t2"], "wt-2"],
  ]);
});

it("refuses a dependency on an ID the manifest does not have", () => {
  const error = failureOf(
    stackOf(feature, [draftOf("Add the command", ["t9"])], () => gate(false), [
      existingOf("t1", "Add the schema", null, null, "landed"),
    ]),
  );
  expect(error.message).toBe(
    '"Add the command" depends on "t9", which is the title of no draft and the ID of no task in the manifest.',
  );
});
