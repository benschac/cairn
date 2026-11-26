import { Manifest, ManifestTask, Sha, Slug, TaskDraft, TaskId } from "@cairn/contract";
import type { HumanGate } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, HashSet, Option, Order, Record, Result, Schema, String, Struct } from "effect";

import {
  STACKS_CLOSE,
  STACKS_OPEN,
  gateOf,
  lint,
  sectionsOf,
  stackOf,
  withStackDiagram,
} from "../src/index.ts";
import type { Finding, LintRule } from "../src/index.ts";

const PRD = Array.join(
  [
    "# Product {#prd.product}",
    "",
    "## Goal {#prd.goal}",
    "",
    "## Billing {#prd.billing}",
    "",
    "<!-- human -->",
    "",
  ],
  "\n",
);
const SPEC = Array.join(
  [
    "# Spec {#spec.spec}",
    "",
    "- Implements: `prd.goal`, `prd.billing`",
    "",
    "## Store {#spec.store}",
    "",
    "## Charge {#spec.charge}",
    "",
  ],
  "\n",
);
const sections = Array.appendAll(sectionsOf(PRD), sectionsOf(SPEC));
const config = { humanPaths: ["**/migrations/**"] };
const feature = Schema.decodeSync(Slug)("cairn-mvp");
const decodeDraft = Schema.decodeUnknownSync(TaskDraft);
const SHA = Schema.decodeSync(Sha)("0123456789abcdef0123456789abcdef01234567");

/**
 * Drafts as a planner might return them. Draft `i` depends on the drafts in `needs` below `i`,
 * links one PRD section and touches one file, which may be a migration. The planner lists them by
 * `key`.
 */
const Drafts = Schema.Array(
  Schema.Struct({
    file: Schema.Literals(["src/store.ts", "db/migrations/001.sql", "src/charge.ts"]),
    key: Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 })),
    needs: Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 }))).check(
      Schema.isMaxLength(3),
    ),
    prd: Schema.Literals(["prd.goal", "prd.billing"]),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(10));
type Drafts = typeof Drafts.Type;

const draftsOf = (drafts: Drafts): ReadonlyArray<TaskDraft> =>
  Array.map(
    Array.sort(
      Array.map(drafts, (draft, index) => ({ draft, index })),
      Order.mapInput(Order.Number, ({ draft }: { readonly draft: Drafts[number] }) => draft.key),
    ),
    ({ draft, index }) =>
      decodeDraft({
        category: "feature",
        dependsOn: Array.map(
          Array.dedupe(Array.filter(draft.needs, (need) => need < index)),
          (need) => `Part ${need}`,
        ),
        files: [draft.file],
        model: "sonnet",
        prdSections: [draft.prd],
        reasoning: "high",
        specSections: ["spec.store"],
        title: `Part ${index}`,
      }),
  );

const gates = (draft: TaskDraft): HumanGate => gateOf(draft, sections, config, []);

/** The manifest `stackOf` writes for the drafts. */
const plannedOf = (drafts: Drafts): Manifest =>
  Schema.decodeUnknownSync(Manifest)({
    baseBranch: "main",
    feature,
    tasks: Schema.encodeSync(Schema.Array(ManifestTask))(
      Result.getOrThrow(stackOf(feature, draftsOf(drafts), gates)),
    ),
    version: 1,
  });

/** The manifest with each task changed by `change`, which gets the task and its position. */
const changed = (
  manifest: Manifest,
  change: (task: ManifestTask, at: number) => ManifestTask,
): Manifest => Struct.evolve(manifest, { tasks: (tasks) => Array.map(tasks, change) });

/** The spec with the stack diagram of `manifest` between markers at its end, so it does not drift. */
const drawn = (manifest: Manifest) =>
  withStackDiagram(`${SPEC}\n${STACKS_OPEN}\n${STACKS_CLOSE}\n`, manifest);

const lintOf = (manifest: Manifest) => lint(PRD, drawn(manifest), Option.some(manifest), config);

const only = (findings: ReadonlyArray<Finding>, rule: LintRule) =>
  Array.map(
    Array.filter(findings, (finding) => finding.rule === rule),
    (finding) => finding.message,
  );

const idAt = (at: number) => TaskId.make(`t${at + 1}`);

/** Everything a task depends on through `links`, directly or through other tasks. */
const closureOf = (
  manifest: Manifest,
  links: (task: ManifestTask) => ReadonlyArray<TaskId>,
  id: TaskId,
): HashSet.HashSet<TaskId> => {
  const byId = Record.fromEntries(Array.map(manifest.tasks, (task) => [task.id, task] as const));
  const visit = (seen: HashSet.HashSet<TaskId>, at: TaskId): HashSet.HashSet<TaskId> =>
    Array.reduce(
      Option.match(Record.get(byId, at), { onNone: () => [], onSome: links }),
      seen,
      (found, next) => (HashSet.has(found, next) ? found : visit(HashSet.add(found, next), next)),
    );
  return visit(HashSet.empty(), id);
};

/** What a task leans on: its dependencies and its parent. */
const links = (task: ManifestTask) =>
  Array.appendAll(task.dependsOn, Option.toArray(Option.fromNullOr(task.parent)));

/** Where a parent puts a task. */
const where = (id: TaskId | null) =>
  Option.getOrElse(Option.fromNullOr(id), () => "the base branch");

/** A gate as the gate-mismatch message words it. */
const gateText = (gate: HumanGate) =>
  gate.required ? `required (${Array.join(gate.reasons, ", ")})` : "not required";

it.prop("a manifest stackOf writes passes every rule", [Drafts], ([drafts]) => {
  // The PRD has no statements, so every task also gets a `task-without-statement` warning.
  expect(
    Array.filter(lintOf(plannedOf(drafts)), ({ rule }) => rule !== "task-without-statement"),
  ).toEqual([]);
});

const Picked = Schema.Struct({
  drafts: Drafts,
  pick: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
});

it.prop(
  "a parent or dependency that is not a task in the manifest is a bad-parent finding",
  [Picked],
  ([{ drafts, pick }]) => {
    const planned = plannedOf(drafts);
    const at = pick % Array.length(planned.tasks);
    const ghost = TaskId.make("t99");
    const broken = changed(planned, (task, index) =>
      index === at
        ? Struct.evolve(task, {
            dependsOn: (dependsOn) => Array.append(dependsOn, ghost),
            parent: () => ghost,
          })
        : task,
    );
    expect(only(lintOf(broken), "bad-parent")).toEqual([
      `${idAt(at)}'s parent t99 is not in the manifest.`,
      `${idAt(at)} depends on t99, which is not in the manifest.`,
    ]);
  },
);

/** Extra dependencies between tasks, in any direction, so some may close a cycle. */
const Looped = Schema.Struct({
  drafts: Drafts,
  extra: Schema.Array(
    Schema.Tuple([
      Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
      Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
    ]),
  ).check(Schema.isMaxLength(4)),
});

it.prop(
  "every task that depends on itself through other tasks is named in a bad-parent finding, and no other",
  [Looped],
  ([{ drafts, extra }]) => {
    const planned = plannedOf(drafts);
    const size = Array.length(planned.tasks);
    const looped = changed(planned, (task, at) =>
      Struct.evolve(task, {
        dependsOn: (dependsOn) =>
          Array.dedupe(
            Array.appendAll(
              dependsOn,
              Array.filterMap(extra, ([from, to]) =>
                from % size === at ? Result.succeed(idAt(to % size)) : Result.failVoid,
              ),
            ),
          ),
      }),
    );
    const onCycle = Array.filterMap(looped.tasks, (task) =>
      HashSet.has(closureOf(looped, links, task.id), task.id)
        ? Result.succeed(task.id)
        : Result.failVoid,
    );
    const named = Array.map(only(lintOf(looped), "bad-parent"), (message) =>
      Option.getOrElse(Array.head(String.split(message, " ")), () => ""),
    );
    expect(named).toEqual(onCycle);
  },
);

it("names a task that depends on itself, and the others on a longer cycle", () => {
  const planned = plannedOf([
    { file: "src/store.ts", key: 0, needs: [], prd: "prd.goal" },
    { file: "src/store.ts", key: 1, needs: [0], prd: "prd.goal" },
    { file: "src/charge.ts", key: 2, needs: [], prd: "prd.goal" },
  ]);
  const looped = changed(planned, (task, at) =>
    Struct.evolve(task, {
      dependsOn: (dependsOn) =>
        at === 0
          ? Array.append(dependsOn, idAt(1))
          : at === 2
            ? Array.append(dependsOn, idAt(2))
            : dependsOn,
    }),
  );
  expect(only(lintOf(looped), "bad-parent")).toEqual([
    "t1 is in a cycle with t2.",
    "t2 is in a cycle with t1.",
    "t3 depends on itself.",
  ]);
});

it.prop(
  "a parent other than the one its dependencies give is a parent-mismatch finding",
  [Picked],
  ([{ drafts, pick }]) => {
    const planned = plannedOf(drafts);
    const at = pick % Array.length(planned.tasks);
    const before = Option.getOrThrow(Array.get(planned.tasks, at));
    const moved: Option.Option<TaskId | null> = Option.match(Option.fromNullOr(before.parent), {
      onNone: () => Array.head(before.dependsOn),
      onSome: () => Option.some(null),
    });
    Option.match(moved, {
      onNone: () => expect(only(lintOf(planned), "parent-mismatch")).toEqual([]),
      onSome: (parent) => {
        const findings = only(
          lintOf(
            changed(planned, (task, index) =>
              index === at ? Struct.evolve(task, { parent: () => parent }) : task,
            ),
          ),
          "parent-mismatch",
        );
        const own = `${before.id} sits on ${where(parent)}, but its dependencies put it on ${where(before.parent)}.`;
        expect(findings).toContain(own);
      },
    });
  },
);

const Checkouts = Schema.Struct({
  drafts: Drafts,
  worktrees: Schema.Array(Schema.Literals(["main", "wt-1", "wt-2"])).check(Schema.isMaxLength(10)),
});

it.prop(
  "two tasks in one worktree where neither depends on the other are a worktree-clash finding",
  [Checkouts],
  ([{ drafts, worktrees }]) => {
    const planned = plannedOf(drafts);
    const placed = changed(planned, (task, at) =>
      Struct.evolve(task, {
        worktree: () =>
          Option.match(Array.get(worktrees, at), {
            onNone: () => `wt-${at + 3}`,
            onSome: (name) => (name === "main" ? null : name),
          }),
      }),
    );
    const needs = (id: TaskId) => closureOf(placed, (task) => task.dependsOn, id);
    const expected = Array.flatMap(placed.tasks, (task, at) =>
      Array.filterMap(Array.take(placed.tasks, at), (other) =>
        other.worktree === task.worktree &&
        !HashSet.has(needs(task.id), other.id) &&
        !HashSet.has(needs(other.id), task.id)
          ? Result.succeed(
              `${other.id} and ${task.id} share ${Option.match(Option.fromNullOr(task.worktree), {
                onNone: () => "the repo's own checkout",
                onSome: (name) => `worktree ${name}`,
              })}, and neither depends on the other.`,
            )
          : Result.failVoid,
      ),
    );
    expect(only(lintOf(placed), "worktree-clash")).toEqual(expected);
  },
);

it.prop(
  "a gate that differs from plan-time detection is a gate-mismatch finding",
  [Picked],
  ([{ drafts, pick }]) => {
    const planned = plannedOf(drafts);
    const at = pick % Array.length(planned.tasks);
    const flipped = changed(planned, (task, index) =>
      index === at
        ? Struct.evolve(task, { humanGate: (gate) => ({ reasons: [], required: !gate.required }) })
        : task,
    );
    const task = Option.getOrThrow(Array.get(planned.tasks, at));
    expect(only(lintOf(flipped), "gate-mismatch")).toEqual([
      `${task.id}'s gate is ${gateText({ reasons: [], required: !task.humanGate.required })}, but plan-time detection finds ${gateText(task.humanGate)}.`,
    ]);
  },
);

it("a gate whose reasons are the same in another order is no mismatch", () => {
  const twoPaths = { humanPaths: ["**/migrations/**", "db/**"] };
  const planned = Schema.decodeUnknownSync(Manifest)({
    baseBranch: "main",
    feature,
    tasks: Schema.encodeSync(Schema.Array(ManifestTask))(
      Result.getOrThrow(
        stackOf(
          feature,
          draftsOf([{ file: "db/migrations/001.sql", key: 0, needs: [], prd: "prd.billing" }]),
          (draft) => gateOf(draft, sections, twoPaths, []),
        ),
      ),
    ),
    version: 1,
  });
  const reordered = changed(planned, (task) =>
    Struct.evolve(task, { humanGate: (gate) => Struct.evolve(gate, { reasons: Array.reverse }) }),
  );
  expect(only(lint(PRD, SPEC, Option.some(reordered), twoPaths), "gate-mismatch")).toEqual([]);
});

const Statuses = Schema.Struct({
  drafts: Drafts,
  landed: Schema.Array(Schema.Struct({ commits: Schema.Boolean, landed: Schema.Boolean })).check(
    Schema.isMaxLength(10),
  ),
});

it.prop(
  "a landed task with no commits is a no-commits-landed warning",
  [Statuses],
  ([{ drafts, landed }]) => {
    const planned = plannedOf(drafts);
    const marked = changed(planned, (task, at) =>
      Option.match(Array.get(landed, at), {
        onNone: () => task,
        onSome: (state) =>
          Struct.evolve(task, {
            commits: () => (state.commits ? [SHA] : []),
            status: () => (state.landed ? "landed" : "pending"),
          }),
      }),
    );
    const findings = Array.filter(
      lintOf(marked),
      (finding) => finding.rule === "no-commits-landed",
    );
    expect(Array.map(findings, (finding) => finding.message)).toEqual(
      Array.filterMap(marked.tasks, (task) =>
        task.status === "landed" && Array.isReadonlyArrayEmpty(task.commits)
          ? Result.succeed(`${task.id} is landed but has no commits.`)
          : Result.failVoid,
      ),
    );
    expect(Array.every(findings, (finding) => finding.severity === "warning")).toBe(true);
    expect(Array.every(findings, (finding) => finding.file === "manifest.json")).toBe(true);
  },
);
