import { PrdSectionId, SectionId, SpecSectionId, TaskStatus } from "@cairn/contract";
import type { Section } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, pipe } from "effect";

import { rollupOf } from "../src/index.ts";
import type { RollupTask } from "../src/index.ts";

const prdId = Schema.decodeSync(PrdSectionId);
const specId = Schema.decodeSync(SpecSectionId);
const sectionId = Schema.decodeSync(SectionId);

const Index = Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 }));

/** A heading tree: heading `n` is under an earlier heading, or at the top when `top` or first. */
const Tree = Schema.Array(Schema.Struct({ top: Schema.Boolean, up: Index })).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(9),
);

/** A spec heading names PRD headings in its `Defers` and `Context` keys, by position, wrapped. */
const SpecTree = Schema.Array(
  Schema.Struct({
    context: Schema.Array(Index).check(Schema.isMaxLength(1)),
    defers: Schema.Array(Index).check(Schema.isMaxLength(1)),
    top: Schema.Boolean,
    up: Index,
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(9));

const Task = Schema.Struct({ prd: Index, spec: Index, status: TaskStatus });

const Plan = Schema.Struct({
  prd: Tree,
  spec: SpecTree,
  tasks: Schema.Array(Task).check(Schema.isMaxLength(8)),
});
type Plan = typeof Plan.Type;

const prdIdAt = (at: number) => prdId(`prd.part-${at}`);
const specIdAt = (at: number) => specId(`spec.part-${at}`);

const wrap = (count: number, number: number) => number % count;
const parentAt = (node: { top: boolean; up: number }, at: number) =>
  node.top || at === 0 ? Option.none() : Option.some(wrap(at, node.up));

const sectionOf = (
  id: string,
  parent: Option.Option<string>,
  keys: Partial<Section["keys"]> = {},
): Section => ({
  body: "",
  human: false,
  id: sectionId(id),
  keys: { context: [], defers: [], dependsOn: [], files: [], implements: [], ...keys },
  level: 1,
  line: 1,
  parent: Option.getOrUndefined(Option.map(parent, sectionId)),
  title: "",
});

const sectionsOf = (plan: Plan) => {
  const prd = Array.map(plan.prd, (node, at) =>
    sectionOf(prdIdAt(at), Option.map(parentAt(node, at), prdIdAt)),
  );
  const spec = Array.map(plan.spec, (node, at) =>
    sectionOf(specIdAt(at), Option.map(parentAt(node, at), specIdAt), {
      context: Array.map(node.context, (to) => prdIdAt(wrap(Array.length(plan.prd), to))),
      defers: Array.map(node.defers, (to) => prdIdAt(wrap(Array.length(plan.prd), to))),
    }),
  );
  return { prd, spec };
};

const tasksOf = (plan: Plan): ReadonlyArray<RollupTask> =>
  Array.map(plan.tasks, (task) => ({
    prdSections: [prdIdAt(wrap(Array.length(plan.prd), task.prd))],
    specSections: [specIdAt(wrap(Array.length(plan.spec), task.spec))],
    status: task.status,
  }));

const rolled = (plan: Plan, tasks: ReadonlyArray<RollupTask> = tasksOf(plan)) => {
  const { prd, spec } = sectionsOf(plan);
  return rollupOf(prd, spec, tasks);
};

const statusIn = (plan: Plan, id: string, tasks?: ReadonlyArray<RollupTask>) =>
  pipe(
    Array.findFirst(rolled(plan, tasks), (section) => section.id === id),
    Option.map(({ status }) => status),
    Option.getOrThrow,
  );

type Heading = { readonly top: boolean; readonly up: number };

/** Whether heading `at` is `above` or under it, by walking the plan's parents one at a time. */
const isUnder = (tree: ReadonlyArray<Heading>, at: number, above: number): boolean =>
  at === above ||
  pipe(
    Array.get(tree, at),
    Option.flatMap((node) => parentAt(node, at)),
    Option.exists((parent) => isUnder(tree, parent, above)),
  );

type Says = Option.Option<"context" | "deferred">;

const saysOf = (deferred: boolean, context: boolean): Says =>
  pipe(
    [
      [deferred, "deferred"],
      [context, "context"],
    ] as const,
    Array.findFirst(([holds]) => holds),
    Option.map(([, key]) => key),
  );

const all = (statuses: ReadonlyArray<TaskStatus>, ...allowed: ReadonlyArray<TaskStatus>) =>
  Array.every(statuses, (status) => Array.contains(allowed, status));

/** The spec's rules for the statuses of the tasks linked to a section, written out in order. */
const expectedFor = (says: Says, linked: ReadonlyArray<TaskStatus>) =>
  pipe(
    [
      [Option.exists(says, (key) => key === "deferred"), "deferred"],
      [Option.isSome(says), "context"],
      [Array.isReadonlyArrayEmpty(linked), "unmapped"],
      [Array.contains(linked, "blocked_on_human"), "blocked_on_human"],
      [Array.contains(linked, "failed"), "failed"],
      [Array.contains(linked, "running"), "running"],
      [all(linked, "landed"), "landed"],
      [all(linked, "landed", "done"), "done"],
      [all(linked, "pending"), "pending"],
      [true, "in_progress"],
    ] as const,
    Array.findFirst(([holds]) => holds),
    Option.map(([, status]) => status),
    Option.getOrThrow,
  );

it.prop(
  "a section's status is the first rule that matches the tasks linked to it or under it",
  [Plan],
  ([plan]) => {
    const prdCount = Array.length(plan.prd);
    const specCount = Array.length(plan.spec);
    const namedBy = (key: "context" | "defers", at: number) =>
      Array.some(plan.spec, (node) =>
        Array.some(node[key], (to) => isUnder(plan.prd, at, wrap(prdCount, to))),
      );
    Array.forEach(plan.prd, (_, at) => {
      const linked = pipe(
        plan.tasks,
        Array.filter((task) => isUnder(plan.prd, wrap(prdCount, task.prd), at)),
        Array.map((task) => task.status),
      );
      expect(statusIn(plan, prdIdAt(at))).toBe(
        expectedFor(saysOf(namedBy("defers", at), namedBy("context", at)), linked),
      );
    });
    Array.forEach(plan.spec, (node, at) => {
      const linked = pipe(
        plan.tasks,
        Array.filter((task) => isUnder(plan.spec, wrap(specCount, task.spec), at)),
        Array.map((task) => task.status),
      );
      expect(statusIn(plan, specIdAt(at))).toBe(
        expectedFor(
          saysOf(
            Array.isReadonlyArrayNonEmpty(node.defers),
            Array.isReadonlyArrayNonEmpty(node.context),
          ),
          linked,
        ),
      );
    });
  },
);

it.prop(
  "every section with an ID is listed once, the PRD's first, in document order",
  [Plan],
  ([plan]) => {
    expect(Array.map(rolled(plan), ({ id }) => id)).toEqual(
      Array.appendAll(
        Array.makeBy(Array.length(plan.prd), prdIdAt),
        Array.makeBy(Array.length(plan.spec), specIdAt),
      ),
    );
  },
);

it.prop("the order of the tasks does not change any status", [Plan], ([plan]) => {
  expect(rolled(plan, Array.reverse(tasksOf(plan)))).toEqual(rolled(plan));
});

it.prop(
  "a deferred or context section keeps its status whatever its tasks do",
  [Plan],
  ([plan]) => {
    const withTasks = rolled(plan);
    const covered = Array.filter(
      rolled(plan, []),
      ({ status }) => status === "deferred" || status === "context",
    );
    Array.forEach(covered, (section) => {
      expect(Array.contains(withTasks, section)).toBe(true);
    });
  },
);

it.prop(
  "with no tasks, a section is unmapped, unless a key defers it or names it as context",
  [Plan],
  ([plan]) => {
    Array.forEach(rolled(plan, []), ({ status }) => {
      expect(["context", "deferred", "unmapped"]).toContain(status);
    });
  },
);

const task = (status: TaskStatus): RollupTask => ({
  prdSections: [prdId("prd.top")],
  specSections: [specId("spec.top")],
  status,
});

it("a section with pending and done tasks is in progress, and any one status alone is itself", () => {
  const prd = [sectionOf("prd.top", Option.none())];
  const spec = [sectionOf("spec.top", Option.none())];
  expect(rollupOf(prd, spec, [task("pending"), task("done")])).toEqual([
    { id: "prd.top", status: "in_progress" },
    { id: "spec.top", status: "in_progress" },
  ]);
  Array.forEach(TaskStatus.literals, (status) => {
    expect(rollupOf(prd, spec, [task(status), task(status)])).toEqual([
      { id: "prd.top", status },
      { id: "spec.top", status },
    ]);
  });
});

it("headings that name each other as parents and headings without an ID do not hang or count", () => {
  const prd = [
    sectionOf("prd.loop", Option.some("prd.loop")),
    { ...sectionOf("prd.top", Option.none()), id: undefined },
  ];
  const spec = [sectionOf("spec.top", Option.none())];
  expect(
    rollupOf(prd, spec, [
      { prdSections: [prdId("prd.loop")], specSections: [specId("spec.top")], status: "failed" },
    ]),
  ).toEqual([
    { id: "prd.loop", status: "failed" },
    { id: "spec.top", status: "failed" },
  ]);
});

/** One PRD heading, `prd.h`, with items under it or under each other, and spec sections that name them. */
const ItemPlan = Schema.Struct({
  items: Tree,
  spec: Schema.Array(
    Schema.Struct({
      context: Schema.Array(Index).check(Schema.isMaxLength(1)),
      defers: Schema.Array(Index).check(Schema.isMaxLength(1)),
      implements: Schema.Array(Index).check(Schema.isMaxLength(2)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  tasks: Schema.Array(Task).check(Schema.isMaxLength(8)),
});

const HEADING = "prd.h";
const itemIdAt = (at: number) => `${HEADING}.i${at}`;

it.prop(
  "an item's status follows the rules for the tasks that name it or build a section implementing it, and its heading's tasks include each item's",
  [ItemPlan],
  ([plan]) => {
    const count = Array.length(plan.items);
    const specCount = Array.length(plan.spec);
    const items = Array.map(plan.items, (node, at) => ({
      id: sectionId(itemIdAt(at)),
      parent: sectionId(
        Option.match(parentAt(node, at), { onNone: () => HEADING, onSome: itemIdAt }),
      ),
    }));
    const spec = Array.map(plan.spec, (node, at) =>
      sectionOf(specIdAt(at), Option.none(), {
        context: Array.map(node.context, (to) => prdId(itemIdAt(wrap(count, to)))),
        defers: Array.map(node.defers, (to) => prdId(itemIdAt(wrap(count, to)))),
        implements: Array.map(node.implements, (to) => prdId(itemIdAt(wrap(count, to)))),
      }),
    );
    // `prd` after wrapping is an item, or `count` for the heading, or `count + 1` for another heading
    const named = (entry: typeof Task.Type) => wrap(count + 2, entry.prd);
    const targetOf = (entry: typeof Task.Type) =>
      named(entry) < count
        ? itemIdAt(named(entry))
        : named(entry) === count
          ? HEADING
          : "prd.other";
    const tasks = Array.map(plan.tasks, (entry): RollupTask => ({
      prdSections: [prdId(targetOf(entry))],
      specSections: [specIdAt(wrap(specCount, entry.spec))],
      status: entry.status,
    }));
    const rolledItems = rollupOf(
      [sectionOf(HEADING, Option.none()), sectionOf("prd.other", Option.none())],
      spec,
      tasks,
      items,
    );
    const statusOfId = (id: string) =>
      pipe(
        Array.findFirst(rolledItems, (section) => section.id === id),
        Option.map(({ status }) => status),
        Option.getOrThrow,
      );
    const implementedBy = (entry: typeof Task.Type): ReadonlyArray<number> =>
      Option.match(Array.get(plan.spec, wrap(specCount, entry.spec)), {
        onNone: () => [],
        onSome: ({ implements: to }) => Array.map(to, (at) => wrap(count, at)),
      });
    const underItem = (above: number, tree: number) => isUnder(plan.items, tree, above);
    Array.forEach(plan.items, (_, at) => {
      const linked = pipe(
        plan.tasks,
        Array.filter(
          (entry) =>
            (named(entry) < count && underItem(at, named(entry))) ||
            Array.some(implementedBy(entry), (to) => underItem(at, to)),
        ),
        Array.map((entry) => entry.status),
      );
      const namedByKey = (key: "context" | "defers") =>
        Array.some(plan.spec, (node) =>
          Array.some(node[key], (to) => underItem(wrap(count, to), at)),
        );
      expect(statusOfId(itemIdAt(at))).toBe(
        expectedFor(saysOf(namedByKey("defers"), namedByKey("context")), linked),
      );
    });
    const ofHeading = pipe(
      plan.tasks,
      Array.filter(
        (entry) => named(entry) <= count || Array.isReadonlyArrayNonEmpty(implementedBy(entry)),
      ),
      Array.map((entry) => entry.status),
    );
    expect(statusOfId(HEADING)).toBe(expectedFor(Option.none(), ofHeading));
  },
);

it("an item with no task is unmapped, and one a Defers names is deferred whatever its tasks do", () => {
  const prd = [sectionOf("prd.top", Option.none())];
  const items = [
    { id: sectionId("prd.top.one"), parent: sectionId("prd.top") },
    { id: sectionId("prd.top.two"), parent: sectionId("prd.top.one") },
  ];
  const spec = [
    sectionOf("spec.top", Option.none(), { implements: [prdId("prd.top.one")] }),
    sectionOf("spec.later", Option.none(), { defers: [prdId("prd.top.two")] }),
  ];
  expect(rollupOf(prd, spec, [], items)).toEqual([
    { id: "prd.top", status: "unmapped" },
    { id: "prd.top.one", status: "unmapped" },
    { id: "prd.top.two", status: "deferred" },
    { id: "spec.top", status: "unmapped" },
    { id: "spec.later", status: "deferred" },
  ]);
  // the task names no PRD section here, so the items are linked only through `Implements`
  const built: ReadonlyArray<RollupTask> = [
    {
      prdSections: [prdId("prd.elsewhere")],
      specSections: [specId("spec.top")],
      status: "running",
    },
  ];
  expect(rollupOf(prd, spec, built, items)).toEqual([
    { id: "prd.top", status: "running" },
    { id: "prd.top.one", status: "running" },
    { id: "prd.top.two", status: "deferred" },
    { id: "spec.top", status: "running" },
    { id: "spec.later", status: "deferred" },
  ]);
});
