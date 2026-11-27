import { readFileSync } from "node:fs";

import {
  Manifest,
  PrdSectionId,
  SectionId,
  SpecIndex,
  SpecSectionId,
  TaskId,
  TaskStatus,
} from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, String, Struct, pipe } from "effect";

import { TaskIdOrder, indexOf, itemsOf, sectionLinksOf, sectionsOf } from "../src/index.ts";
import type { IndexTask, RelationIndex, SectionTree, StatusOf } from "../src/index.ts";

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const taskId = (at: number) => TaskId.make(`t${at + 1}`);
const specId = (at: number) => SpecSectionId.make(`spec.s${at}`);

/** Three parts, the first with a subsection, each with an item. */
const PRD = Array.join(
  [
    "## Part 0 {#prd.p0}",
    "",
    "- A thing. {#prd.p0.thing}",
    "",
    "### Sub {#prd.p0.sub}",
    "",
    "- A smaller thing. {#prd.p0.sub.bit}",
    "",
    "## Part 1 {#prd.p1}",
    "",
    "- A thing. {#prd.p1.thing}",
    "",
    "## Part 2 {#prd.p2}",
    "",
    "- A thing. {#prd.p2.thing}",
    "",
  ],
  "\n",
);
const PRD_IDS = Array.map(
  [
    "prd.p0",
    "prd.p0.thing",
    "prd.p0.sub",
    "prd.p0.sub.bit",
    "prd.p1",
    "prd.p1.thing",
    "prd.p2",
    "prd.p2.thing",
  ],
  (id) => PrdSectionId.make(id),
);
const prdSections = sectionsOf(PRD);
const tree: SectionTree = { items: itemsOf(PRD, prdSections), sections: prdSections, spec: [] };

const pick = <A>(pool: ReadonlyArray<A>, at: number): A =>
  Option.getOrThrow(Array.get(pool, at % Array.length(pool)));

const Pointer = Schema.Int.check(Schema.isBetween({ maximum: 11, minimum: 0 }));
const Pointers = Schema.Array(Pointer).check(Schema.isMaxLength(3));

/** A plan as numbers: task `n` is `t(n+1)` and needs only tasks before it unless `cyclic`. */
const Shape = Schema.Struct({
  cyclic: Schema.Boolean,
  sections: Schema.Array(Schema.Struct({ implements: Pointers })).check(Schema.isMaxLength(4)),
  tasks: Schema.Array(
    Schema.Struct({
      builds: Pointer,
      names: Schema.NonEmptyArray(Pointer).check(Schema.isMaxLength(3)),
      needs: Pointers,
      status: TaskStatus,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
});
type Shape = typeof Shape.Type;

const tasksOf = (shape: Shape): ReadonlyArray<IndexTask> =>
  Array.map(shape.tasks, (task, at) => ({
    dependsOn: Array.map(
      Array.filter(task.needs, (need) => shape.cyclic || need < at),
      taskId,
    ),
    id: taskId(at),
    orderedAfter: [],
    parent: null,
    prdSections: Array.map(task.names, (name) => pick(PRD_IDS, name)),
    specSections: [specId(task.builds % 4)],
  }));

const indexFor = (shape: Shape): RelationIndex =>
  indexOf({
    manifest: { tasks: tasksOf(shape) },
    prd: PRD,
    specIndex: {
      sections: Array.map(shape.sections, (section, at) => ({
        dependsOn: [],
        id: specId(at),
        implements: Array.map(section.implements, (implemented) => pick(PRD_IDS, implemented)),
        tests: [],
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

/** What `task` links to directly: what it names, and what the spec sections it builds implement. */
const directOf = (index: RelationIndex, task: string): ReadonlyArray<string> =>
  Array.appendAll(
    Array.map(index.out(task, "names"), ({ to }) => to.id),
    Array.flatMap(index.out(task, "builds"), ({ to }) =>
      Array.map(index.out(to.id, "implements"), (implemented) => implemented.to.id),
    ),
  );

/** `other` is `id` or sits under it in the test PRD. */
const isUnder = (other: string, id: string) => other === id || String.startsWith(`${id}.`)(other);

it.prop(
  "a link's pairs run from one of the section's own tasks to a direct task of the other end (spec.status.section-links#t1)",
  [Shape],
  ([shape]) => {
    const index = indexFor(shape);
    const statusOf = statusesOf(shape);
    Array.forEach(PRD_IDS, (id) => {
      const links = sectionLinksOf(index, tree, id, { statusOf });
      Array.forEach(links.tasks, (task) =>
        expect(Array.some(directOf(index, task), (target) => isUnder(target, id))).toBe(true),
      );
      Array.forEach(links.needs, (link) =>
        Array.forEach(link.pairs, ({ needs, task }) => {
          expect(Array.contains(links.tasks, task)).toBe(true);
          expect(Array.contains(links.tasks, needs)).toBe(false);
          expect(Array.contains(directOf(index, needs), link.id)).toBe(true);
          expect(
            Array.contains(
              Array.map(index.out(task, "needs"), ({ to }) => to.id),
              needs,
            ),
          ).toBe(true);
        }),
      );
      Array.forEach(links.neededBy, (link) =>
        Array.forEach(link.pairs, ({ needs, task }) => {
          expect(Array.contains(links.tasks, needs)).toBe(true);
          expect(Array.contains(links.tasks, task)).toBe(false);
          expect(Array.contains(directOf(index, task), link.id)).toBe(true);
        }),
      );
    });
  },
);

it.prop(
  "a section never needs itself or anything under it, directly or not (spec.status.section-links#t1)",
  [Shape],
  ([shape]) => {
    const index = indexFor(shape);
    const statusOf = statusesOf(shape);
    Array.forEach(PRD_IDS, (id) =>
      Array.forEach([false, true], (transitive) => {
        const links = sectionLinksOf(index, tree, id, { statusOf, transitive });
        Array.forEach(Array.appendAll(links.needs, links.neededBy), (link) =>
          expect(isUnder(link.id, id)).toBe(false),
        );
      }),
    );
  },
);

it.prop(
  "ready counts the next tasks that can start, and next holds the unfinished own tasks, those that can start first (spec.status.section-links#t1)",
  [Shape],
  ([shape]) => {
    const index = indexFor(shape);
    const statusOf = statusesOf(shape);
    Array.forEach(PRD_IDS, (id) => {
      const links = sectionLinksOf(index, tree, id, { statusOf });
      expect(links.ready).toBe(Array.length(Array.filter(links.next, ({ canStart }) => canStart)));
      const unfinished = Array.filter(
        links.tasks,
        (task) => statusOf(task) !== "done" && statusOf(task) !== "landed",
      );
      expect(
        Array.sort(
          Array.map(links.next, ({ task }) => task),
          TaskIdOrder,
        ),
      ).toEqual(Array.sort(unfinished, TaskIdOrder));
      Array.forEach(links.next, ({ canStart }, at) => expect(canStart).toBe(at < links.ready));
      Array.forEach(links.next, ({ canStart, task, waitsOn }) => {
        expect(canStart).toBe(index.canStart(task, statusOf));
        expect(waitsOn).toEqual(index.waitsOn(task, statusOf));
      });
    });
  },
);

it.prop(
  "everything before and after holds the direct links, and each other entry is reached through one of them",
  [Shape],
  ([shape]) => {
    const index = indexFor(shape);
    const statusOf = statusesOf(shape);
    Array.forEach(PRD_IDS, (id) => {
      const direct = sectionLinksOf(index, tree, id, { statusOf });
      const all = sectionLinksOf(index, tree, id, { statusOf, transitive: true });
      Array.forEach(
        [
          [direct.needs, all.needs],
          [direct.neededBy, all.neededBy],
        ] as const,
        ([near, far]) => {
          const nearIds = Array.map(near, (link) => link.id);
          Array.forEach(near, (link) => expect(link.via).toEqual(Option.none()));
          Array.forEach(nearIds, (other) =>
            expect(
              Array.contains(
                Array.map(far, (link) => link.id),
                other,
              ),
            ).toBe(true),
          );
          Array.forEach(far, (link) =>
            Array.contains(nearIds, link.id)
              ? expect(link.via).toEqual(Option.none())
              : expect(
                  Option.match(link.via, {
                    onNone: () => true,
                    onSome: (through) => Array.contains(nearIds, through),
                  }),
                ).toBe(true),
          );
        },
      );
    });
  },
);

/** Part 0's task needs part 1's, which needs part 2's; part 2's task is done. */
const CHAIN: Shape = {
  cyclic: false,
  sections: [],
  tasks: [
    { builds: 0, names: [6], needs: [], status: "done" },
    { builds: 0, names: [4], needs: [0], status: "pending" },
    { builds: 0, names: [1], needs: [1], status: "pending" },
    { builds: 0, names: [0], needs: [], status: "pending" },
  ],
};

it("lists what a section needs directly, everything before it in build order, and its next tasks", () => {
  const index = indexFor(CHAIN);
  const statusOf = statusesOf(CHAIN);
  const p0 = PrdSectionId.make("prd.p0");
  const direct = sectionLinksOf(index, tree, p0, { statusOf });
  expect(direct.tasks).toEqual(["t3", "t4"]);
  expect(direct.needs).toEqual([
    { id: "prd.p1", pairs: [{ needs: "t2", task: "t3" }], via: Option.none() },
  ]);
  expect(direct.neededBy).toEqual([]);
  expect(direct.next).toEqual([
    { canStart: true, task: "t4", waitsOn: [] },
    { canStart: false, task: "t3", waitsOn: ["t2"] },
  ]);
  expect(direct.ready).toBe(1);
  expect(sectionLinksOf(index, tree, p0, { statusOf, transitive: true }).needs).toEqual([
    { id: "prd.p2", pairs: [{ needs: "t1", task: "t2" }], via: Option.some("prd.p1") },
    { id: "prd.p1", pairs: [{ needs: "t2", task: "t3" }], via: Option.none() },
  ]);
  expect(
    sectionLinksOf(index, tree, PrdSectionId.make("prd.p2"), { statusOf, transitive: true })
      .neededBy,
  ).toEqual([
    { id: "prd.p1", pairs: [{ needs: "t1", task: "t2" }], via: Option.none() },
    { id: "prd.p0.thing", pairs: [{ needs: "t2", task: "t3" }], via: Option.some("prd.p1") },
  ]);
});

it("an item's tasks count toward its section's, and a task inside the section is not a link", () => {
  const index = indexFor(CHAIN);
  const statusOf = statusesOf(CHAIN);
  const item = sectionLinksOf(index, tree, PrdSectionId.make("prd.p0.thing"), { statusOf });
  expect(item.tasks).toEqual(["t3"]);
  expect(Array.map(item.needs, (link) => link.id)).toEqual(["prd.p1"]);
  const p1 = sectionLinksOf(index, tree, PrdSectionId.make("prd.p1"), { statusOf });
  expect(Array.map(p1.neededBy, (link) => link.id)).toEqual(["prd.p0.thing"]);
  expect(p1.next).toEqual([{ canStart: true, task: "t2", waitsOn: [] }]);
});

it("on this repo's plan, Fuzzy search needs Task detail through t95 needs t94, and the reverse link holds (spec.status.section-links#t2, prd.viewer.dependencies#v1)", () => {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    repo(".cairn/manifest.json"),
  );
  const specIndex = Schema.decodeUnknownSync(Schema.fromJsonString(SpecIndex))(
    repo(".cairn/spec.json"),
  );
  const prd = repo(".cairn/prd.md");
  const sections = sectionsOf(prd);
  const repoTree: SectionTree = {
    items: itemsOf(prd, sections),
    sections,
    spec: sectionsOf(repo(".cairn/spec.md")),
  };
  const index = indexOf({ manifest, prd, specIndex });
  const statusOf: StatusOf = (task) =>
    Option.match(
      Array.findFirst(manifest.tasks, ({ id }) => id === task),
      { onNone: () => "pending", onSome: ({ status }) => status },
    );
  const pair = { needs: TaskId.make("t94"), task: TaskId.make("t95") };
  const fuzzy = sectionLinksOf(index, repoTree, PrdSectionId.make("prd.viewer.fuzzy-search"), {
    statusOf,
  });
  const detail = sectionLinksOf(index, repoTree, PrdSectionId.make("prd.viewer.task-detail"), {
    statusOf,
  });
  expect(
    Option.map(
      Array.findFirst(fuzzy.needs, ({ id }) => id === "prd.viewer.task-detail"),
      ({ pairs }) =>
        Array.contains(
          Array.map(pairs, ({ needs, task }) => `${task}>${needs}`),
          "t95>t94",
        ),
    ),
  ).toEqual(Option.some(true));
  expect(
    Option.map(
      Array.findFirst(detail.neededBy, ({ id }) => id === "prd.viewer.fuzzy-search"),
      ({ pairs }) =>
        Array.contains(
          Array.map(pairs, ({ needs, task }) => `${task}>${needs}`),
          `${pair.task}>${pair.needs}`,
        ),
    ),
  ).toEqual(Option.some(true));
});

const allPending: StatusOf = () => "pending";

it("a task that builds a spec section under one that implements an item is one of the item's own tasks", () => {
  const index = indexOf({
    manifest: {
      tasks: [
        {
          dependsOn: [],
          id: TaskId.make("t1"),
          orderedAfter: [],
          parent: null,
          prdSections: [PrdSectionId.make("prd.p2")],
          specSections: [SpecSectionId.make("spec.a.b")],
        },
      ],
    },
    prd: PRD,
    specIndex: {
      sections: [
        {
          dependsOn: [],
          id: SpecSectionId.make("spec.a"),
          implements: [PrdSectionId.make("prd.p1.thing")],
          tests: [],
        },
        { dependsOn: [], id: SpecSectionId.make("spec.a.b"), implements: [], tests: [] },
      ],
    },
  });
  const spec = [
    { id: SectionId.make("spec.a"), parent: undefined },
    { id: SectionId.make("spec.a.b"), parent: SectionId.make("spec.a") },
  ];
  const item = PrdSectionId.make("prd.p1.thing");
  expect(
    sectionLinksOf(index, Struct.assign(tree, { spec }), item, { statusOf: allPending }).tasks,
  ).toEqual(["t1"]);
  expect(sectionLinksOf(index, tree, item, { statusOf: allPending }).tasks).toEqual([]);
});

it("a task whose spec section implements a heading it does not name links to the heading but is not one of its own", () => {
  const index = indexOf({
    manifest: {
      tasks: [
        {
          dependsOn: [],
          id: TaskId.make("t1"),
          orderedAfter: [],
          parent: null,
          prdSections: [PrdSectionId.make("prd.p2")],
          specSections: [SpecSectionId.make("spec.a")],
        },
        {
          dependsOn: [TaskId.make("t1")],
          id: TaskId.make("t2"),
          orderedAfter: [],
          parent: null,
          prdSections: [PrdSectionId.make("prd.p1")],
          specSections: [SpecSectionId.make("spec.b")],
        },
      ],
    },
    prd: PRD,
    specIndex: {
      sections: [
        {
          dependsOn: [],
          id: SpecSectionId.make("spec.a"),
          implements: [PrdSectionId.make("prd.p1")],
          tests: [],
        },
        { dependsOn: [], id: SpecSectionId.make("spec.b"), implements: [], tests: [] },
      ],
    },
  });
  const p1 = sectionLinksOf(index, tree, PrdSectionId.make("prd.p1"), { statusOf: allPending });
  expect(p1.tasks).toEqual(["t2"]);
  expect(p1.next).toEqual([{ canStart: false, task: "t2", waitsOn: ["t1"] }]);
  expect(Array.map(p1.needs, ({ id }) => id)).toEqual(["prd.p2"]);
});

it("on this repo's plan, a task that only builds a spec section implementing Task detail is not one of its own", () => {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    repo(".cairn/manifest.json"),
  );
  const specIndex = Schema.decodeUnknownSync(Schema.fromJsonString(SpecIndex))(
    repo(".cairn/spec.json"),
  );
  const prd = repo(".cairn/prd.md");
  const sections = sectionsOf(prd);
  const index = indexOf({ manifest, prd, specIndex });
  const links = sectionLinksOf(
    index,
    { items: itemsOf(prd, sections), sections, spec: sectionsOf(repo(".cairn/spec.md")) },
    PrdSectionId.make("prd.viewer.task-detail"),
    { statusOf: allPending },
  );
  const named = Array.filter(manifest.tasks, (task) =>
    Array.some(
      task.prdSections,
      (id) => id === "prd.viewer.task-detail" || String.startsWith("prd.viewer.task-detail.")(id),
    ),
  );
  expect(Array.sort(links.tasks, TaskIdOrder)).toEqual(
    Array.sort(
      Array.map(named, ({ id }) => id),
      TaskIdOrder,
    ),
  );
});
