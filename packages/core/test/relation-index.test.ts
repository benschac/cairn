import { readFileSync } from "node:fs";

import {
  Manifest,
  PrdSectionId,
  SectionId,
  SpecSectionId,
  StatementId,
  TaskId,
  TaskStatus,
  TestId,
} from "@cairn/contract";
import type { Relation, RelationKind, TraceSection } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Record, Schema, Struct, pipe } from "effect";

import { indexOf } from "../src/index.ts";
import type { IndexTask, RelationIndex, RelationSource, StatusOf } from "../src/index.ts";

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const taskId = (at: number) => TaskId.make(`t${at + 1}`);

/** The PRD every generated plan points into: three sections, each with an item and a statement. */
const PRD = Array.join(
  Array.flatMap([0, 1, 2], (at) => [
    `## Part ${at} {#prd.p${at}}`,
    "",
    `- A thing to build. {#prd.p${at}.thing}`,
    "",
    "Done when:",
    "",
    `- It is built. {#prd.p${at}#v1}`,
    "",
  ]),
  "\n",
);
/** What `names` and `implements` point at: sections, items and two that do not exist. */
const PRD_ENDS = Array.map(
  [
    "prd.p0",
    "prd.p0.thing",
    "prd.p1",
    "prd.p1.thing",
    "prd.p2",
    "prd.p2.thing",
    "prd.gone",
    "prd.p9.thing",
  ],
  (id) => PrdSectionId.make(id),
);
/** What `proves` points at: the three statements and one that does not exist. */
const STATEMENTS = Array.map(["prd.p0#v1", "prd.p1#v1", "prd.p2#v1", "prd.p3#v1"], (id) =>
  StatementId.make(id),
);
const specId = (at: number) => SpecSectionId.make(`spec.s${at}`);

const pick = <A>(pool: ReadonlyArray<A>, at: number): A =>
  Option.getOrThrow(Array.get(pool, at % Array.length(pool)));

const Pointer = Schema.Int.check(Schema.isBetween({ maximum: 13, minimum: 0 }));
const Pointers = Schema.Array(Pointer).check(Schema.isMaxLength(4));

/**
 * A plan as numbers. Task `n` is `t(n+1)`; a pointer past the last task, section or PRD end names
 * one that does not exist, so some relations dangle. With `acyclic`, a task needs only tasks
 * before it.
 */
const Shape = Schema.Struct({
  sections: Schema.Array(
    Schema.Struct({ dependsOn: Pointers, implements: Pointers, proves: Pointers }),
  ).check(Schema.isMaxLength(5)),
  tasks: Schema.Array(
    Schema.Struct({
      after: Pointers,
      builds: Pointer,
      names: Pointers,
      needs: Pointers,
      parent: Schema.NullOr(Pointer),
      status: TaskStatus,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
});
type Shape = typeof Shape.Type;

const tasksOf = (shape: Shape, acyclic: boolean): ReadonlyArray<IndexTask> =>
  Array.map(shape.tasks, (task, at) => ({
    dependsOn: Array.map(
      Array.filter(task.needs, (need) => !acyclic || need < at),
      taskId,
    ),
    id: taskId(at),
    orderedAfter: Array.map(task.after, (after) => ({ reason: "same file", task: taskId(after) })),
    parent: Option.getOrNull(Option.map(Option.fromNullOr(task.parent), taskId)),
    prdSections: Array.prepend(
      Array.map(task.names, (name) => pick(PRD_ENDS, name)),
      pick(PRD_ENDS, task.builds),
    ),
    specSections: Array.make(specId(task.builds % 7)),
  }));

const sourceOf = (shape: Shape, acyclic = false): RelationSource => ({
  manifest: { tasks: tasksOf(shape, acyclic) },
  prd: PRD,
  specIndex: {
    sections: Array.map(shape.sections, (section, at) => ({
      dependsOn: Array.map(section.dependsOn, (depends) => specId(depends % 7)),
      id: specId(at),
      implements: Array.map(section.implements, (implemented) => pick(PRD_ENDS, implemented)),
      tests: [
        {
          id: TestId.make(`spec.s${at}#t1`),
          kind: "property" as const,
          proves: Array.map(section.proves, (proved) => pick(STATEMENTS, proved)),
          text: "It holds.",
        },
      ],
    })),
  },
});

const statusesOf =
  (shape: Shape): StatusOf =>
  (task) =>
    pipe(
      Array.findFirstIndex(shape.tasks, (_, at) => taskId(at) === task),
      Option.flatMap((at) => Array.get(shape.tasks, at)),
      Option.match({ onNone: () => "pending", onSome: ({ status }) => status }),
    );

const KINDS: ReadonlyArray<RelationKind> = [
  "needs",
  "builtOn",
  "orderedAfter",
  "builds",
  "names",
  "implements",
  "dependsOn",
  "proves",
];

/** Every ID a generated plan can name, the ones that do not exist included. */
const idsOf = (shape: Shape): ReadonlyArray<string> =>
  Array.flatten([
    Array.makeBy(14, taskId),
    Array.makeBy(7, specId),
    PRD_ENDS,
    STATEMENTS,
    Array.makeBy(Array.length(shape.sections), (at) => `spec.s${at}#t1`),
  ]);

/** A source with only a manifest: no spec sections and an empty PRD. */
const sourceWith = (tasks: Manifest): RelationSource => ({
  manifest: tasks,
  prd: "",
  specIndex: { sections: [] },
});

const tasksIn = (shape: Shape) => Array.makeBy(Array.length(shape.tasks), taskId);

/** The relation itself is in `relations`, not only one equal to it. */
const contains = (relations: ReadonlyArray<Relation>, relation: Relation) =>
  Array.some(relations, (other) => other === relation);

/** A PRD section's keys in a trace: always empty. */
const NO_KEYS: TraceSection["keys"] = {
  context: [],
  defers: [],
  dependsOn: [],
  files: [],
  implements: [],
};

const directNeeds = (index: RelationIndex, task: TaskId) =>
  Array.map(index.out(task, "needs"), ({ to }) => to.id);

it.prop(
  "out and into are inverses for every kind, and leave out what dangles (spec.status.relation-index#t1)",
  [Shape],
  ([shape]) => {
    const index = indexOf(sourceOf(shape));
    Array.forEach(KINDS, (kind) =>
      Array.forEach(idsOf(shape), (id) => {
        Array.forEach(index.out(id, kind), (relation) => {
          expect(relation.from.id).toBe(id);
          expect(relation.kind).toBe(kind);
          expect(contains(index.into(relation.to.id, kind), relation)).toBe(true);
        });
        Array.forEach(index.into(id, kind), (relation) => {
          expect(relation.to.id).toBe(id);
          expect(contains(index.out(relation.from.id, kind), relation)).toBe(true);
        });
      }),
    );
    Array.forEach(index.dangling, (relation) => {
      expect(
        Array.some(
          index.out(relation.from.id, relation.kind),
          (other) => other.to.id === relation.to.id && other.to.kind === relation.to.kind,
        ),
      ).toBe(false);
    });
  },
);

it.prop(
  "buildOrder puts every task after everything it needs and leaves out only tasks in a cycle (spec.status.relation-index#t2)",
  [Shape],
  ([shape]) => {
    const index = indexOf(sourceOf(shape));
    const order = index.buildOrder();
    const cyclic = Array.flatten(index.cycles);
    Array.forEach(order, (task, at) =>
      Array.forEach(directNeeds(index, task), (need) => {
        const placed = Array.findFirstIndex(order, (other) => other === need);
        expect(
          Option.isNone(placed) ? Array.contains(cyclic, need) : Option.getOrThrow(placed) < at,
        ).toBe(true);
      }),
    );
    expect(Array.length(order) + Array.length(cyclic)).toBe(Array.length(shape.tasks));
    expect(Array.intersection(order, cyclic)).toEqual([]);
  },
);

it.prop(
  "canStart is true exactly when waitsOn is empty for a pending task (spec.status.relation-index#t3)",
  [Shape],
  ([shape]) => {
    const index = indexOf(sourceOf(shape));
    const statusOf = statusesOf(shape);
    Array.forEach(tasksIn(shape), (task) =>
      expect(index.canStart(task, statusOf)).toBe(
        statusOf(task) === "pending" && Array.isReadonlyArrayEmpty(index.waitsOn(task, statusOf)),
      ),
    );
  },
);

it.prop(
  "a manifest with no cycle has empty cycles and orders every task (spec.status.relation-index#t4)",
  [Shape],
  ([shape]) => {
    const index = indexOf(sourceOf(shape, true));
    expect(index.cycles).toEqual([]);
    expect(Array.length(index.buildOrder())).toBe(Array.length(shape.tasks));
  },
);

it.prop(
  "needsAll and neededByAll mirror each other, and canRunTogether is neither needing the other",
  [Shape],
  ([shape]) => {
    const index = indexOf(sourceOf(shape));
    Array.forEach(Array.cartesian(tasksIn(shape), tasksIn(shape)), ([a, b]) => {
      const aNeedsB = Array.contains(index.needsAll(a), b);
      expect(Array.contains(index.neededByAll(b), a)).toBe(aNeedsB);
      if (a !== b) {
        expect(index.canRunTogether(a, b)).toBe(!aNeedsB && !Array.contains(index.needsAll(b), a));
      }
    });
    Array.forEach(tasksIn(shape), (task) =>
      Array.forEach(directNeeds(index, task), (need) =>
        expect(Array.contains(Array.append(index.needsAll(task), task), need)).toBe(true),
      ),
    );
  },
);

it.prop(
  "waitsOn and waitedOnBy are the unfinished direct needs in each direction",
  [Shape],
  ([shape]) => {
    const index = indexOf(sourceOf(shape));
    const statusOf = statusesOf(shape);
    const unfinished = (task: TaskId) => statusOf(task) !== "done" && statusOf(task) !== "landed";
    Array.forEach(Array.cartesian(tasksIn(shape), tasksIn(shape)), ([a, b]) => {
      const needs = Array.contains(directNeeds(index, a), b);
      expect(Array.contains(index.waitsOn(a, statusOf), b)).toBe(needs && unfinished(b));
      expect(Array.contains(index.waitedOnBy(b, statusOf), a)).toBe(needs && unfinished(a));
    });
  },
);

it.prop(
  "marking a pending task's only unfinished dependency done lets it start (prd.relations.index#v2)",
  [Shape],
  ([shape]) => {
    const index = indexOf(sourceOf(shape, true));
    const statusOf = statusesOf(shape);
    Array.forEach(tasksIn(shape), (task) => {
      const waits = index.waitsOn(task, statusOf);
      if (statusOf(task) === "pending" && Array.length(waits) === 1) {
        const marked: StatusOf = (other) =>
          Array.contains(waits, other) ? "done" : statusOf(other);
        expect(index.canStart(task, statusOf)).toBe(false);
        expect(index.canStart(task, marked)).toBe(true);
      }
    });
  },
);

it("marking a task's only unfinished dependency done makes it able to start, with nothing else changed (spec.status.relation-index#t6, prd.relations.index#v2)", () => {
  const shape: Shape = {
    sections: [],
    tasks: [
      { after: [], builds: 0, names: [], needs: [], parent: null, status: "done" },
      { after: [], builds: 0, names: [], needs: [], parent: null, status: "running" },
      { after: [], builds: 0, names: [], needs: [0, 1], parent: 1, status: "pending" },
    ],
  };
  const index = indexOf(sourceOf(shape));
  const before = statusesOf(shape);
  const after: StatusOf = (task) => (task === taskId(1) ? "done" : before(task));
  expect(index.waitsOn(taskId(2), before)).toEqual([taskId(1)]);
  expect(index.canStart(taskId(2), before)).toBe(false);
  expect(index.waitsOn(taskId(2), after)).toEqual([]);
  expect(index.canStart(taskId(2), after)).toBe(true);
  expect(index.waitedOnBy(taskId(1), before)).toEqual([taskId(2)]);
});

it("this repo's manifest with t71 made to depend on t73 has the cycle t71, t72, t73 (spec.status.relation-index#t5, prd.relations.index#v1)", () => {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    repo(".cairn/manifest.json"),
  );
  const t73 = TaskId.make("t73");
  const broken = Struct.evolve(manifest, {
    tasks: (tasks) =>
      Array.map(tasks, (task) =>
        task.id === "t71"
          ? Struct.evolve(task, { dependsOn: (dependsOn) => Array.append(dependsOn, t73) })
          : task,
      ),
  });
  expect(indexOf(sourceWith(manifest)).cycles).toEqual([]);
  const index = indexOf(sourceWith(broken));
  expect(index.cycles).toEqual([["t71", "t72", "t73"]]);
  expect(Array.contains(index.buildOrder(), TaskId.make("t71"))).toBe(false);
});

it("reads a trace: a section's own Implements and Depends on, a repeated one included, and proves from each statement", () => {
  const index = indexOf({
    trace: {
      prd: {
        items: [],
        sections: [
          {
            human: false,
            id: SectionId.make("prd.a"),
            keys: NO_KEYS,
            level: 2,
            line: 1,
            parent: null,
            summary: null,
            title: "A",
          },
          {
            human: false,
            id: SectionId.make("prd.b"),
            keys: NO_KEYS,
            level: 2,
            line: 3,
            parent: null,
            summary: null,
            title: "B",
          },
        ],
        statements: [
          {
            draft: false,
            human: false,
            id: StatementId.make("prd.b#v1"),
            line: 5,
            owner: PrdSectionId.make("prd.b"),
            provedBy: [TestId.make("spec.x.y#t1")],
            text: "It works.",
          },
        ],
      },
      spec: {
        markdown: Array.join(
          [
            "## X {#spec.x}",
            "",
            "- Implements: `prd.a`",
            "- Depends on: `spec.z`",
            "",
            "### Y {#spec.x.y}",
            "",
            "- Implements: `prd.a`, `prd.b`",
            "- Depends on: `spec.x`",
            "",
            "### Z {#spec.x.z}",
            "",
            "Nothing of its own.",
          ],
          "\n",
        ),
      },
      tasks: [
        {
          dependsOn: [],
          id: TaskId.make("t1"),
          orderedAfter: [],
          parent: null,
          prdSections: [PrdSectionId.make("prd.b")],
          specSections: [SpecSectionId.make("spec.x.y")],
        },
      ],
    },
  });
  expect(Array.map(index.out("spec.x.y", "implements"), ({ to }) => to.id)).toEqual([
    "prd.a",
    "prd.b",
  ]);
  expect(index.out("spec.x.z", "implements")).toEqual([]);
  expect(index.out("spec.x.z", "dependsOn")).toEqual([]);
  expect(Array.map(index.out("spec.x.y", "dependsOn"), ({ to }) => to.id)).toEqual(["spec.x"]);
  expect(Array.map(index.into("prd.b#v1", "proves"), ({ from }) => from)).toEqual([
    { id: "spec.x.y#t1", kind: "test" },
  ]);
  expect(Array.map(index.dangling, ({ to }) => to.id)).toEqual(["spec.z"]);
});

it("an item end is an item, and a name that does not exist dangles", () => {
  const shape: Shape = {
    sections: [],
    tasks: [{ after: [], builds: 1, names: [6], needs: [5], parent: null, status: "pending" }],
  };
  const index = indexOf(sourceOf(shape));
  expect(index.out("t1", "names")).toEqual([
    { from: { id: "t1", kind: "task" }, kind: "names", to: { id: "prd.p0.thing", kind: "item" } },
  ]);
  expect(
    Record.fromEntries(Array.map(index.dangling, ({ kind, to }) => [kind, to.id] as const)),
  ).toEqual({ builds: "spec.s1", names: "prd.gone", needs: "t6" });
});
