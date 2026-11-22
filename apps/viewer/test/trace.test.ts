import { Trace } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Order, Schema } from "effect";

import { Node, chainOf, isInChain } from "../src/trace.ts";

const index = Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 }));
const indexes = Schema.Array(index);
const links = Schema.NonEmptyArray(index);

/** A small linked trace: indexes pick which PRD and spec sections each section or task links to. */
const Shape = Schema.Struct({
  specs: Schema.Array(indexes),
  tasks: Schema.Array(Schema.Struct({ prd: links, spec: links })),
});

const taskBase = {
  branch: "cairn/01-a",
  commits: [],
  dependsOn: [],
  events: [],
  files: [],
  gate: { reasons: [], required: false },
  humanGate: { reasons: [], required: false },
  model: "m",
  parent: null,
  reasoning: "low",
  sessions: [],
  status: "pending",
  title: "t",
  waiting: false,
  worktree: null,
};

const prdId = (n: number) => `prd.p${n}`;
const specId = (n: number) => `spec.s${n}`;
const prdIds = Array.makeBy(5, prdId);
const specIds = Array.makeBy(5, specId);

const section = (id: string, implementsIds: ReadonlyArray<string>) => ({
  human: false,
  id,
  keys: { context: [], defers: [], dependsOn: [], files: [], implements: implementsIds },
  level: 1,
  line: 1,
  parent: null,
  title: id,
});

const build = (shape: typeof Shape.Type): Trace =>
  Schema.decodeUnknownSync(Trace)({
    baseBranch: "main",
    feature: "demo",
    judgments: [],
    prd: { markdown: "", path: "prd.md", sections: prdIds.map((id) => section(id, [])) },
    sections: [],
    spec: {
      markdown: "",
      path: "spec.md",
      sections: specIds.map((id, n) =>
        section(
          id,
          (shape.specs[n] ?? []).map((p) => prdId(p)),
        ),
      ),
    },
    tasks: shape.tasks.map((task, n) => ({
      ...taskBase,
      id: `t${n}`,
      prdSections: task.prd.map((p) => prdId(p)),
      specSections: task.spec.map((s) => specId(s)),
    })),
    version: 1,
    warnings: [],
  });

const decodeNode = Schema.decodeUnknownSync(Node);
const sectionNode = (id: string) => decodeNode({ id, kind: "section" });
const taskNode = (id: string) => decodeNode({ id, kind: "task" });

const nodesOf = (trace: Trace): ReadonlyArray<Node> => [
  ...trace.prd.sections.map((s) => sectionNode(s.id)),
  ...trace.spec.sections.map((s) => sectionNode(s.id)),
  ...trace.tasks.map((task) => taskNode(task.id)),
];

it.prop("a node is in its own chain", [Shape], ([shape]) => {
  const trace = build(shape);
  for (const node of nodesOf(trace)) {
    expect(isInChain(chainOf(trace, node), node)).toBe(true);
  }
});

it.prop(
  "links are symmetric between sections and tasks and between PRD and spec",
  [Shape],
  ([shape]) => {
    const trace = build(shape);
    const nodes = nodesOf(trace);
    for (const a of nodes) {
      for (const b of nodes) {
        if (isInChain(chainOf(trace, a), b)) {
          expect(isInChain(chainOf(trace, b), a)).toBe(true);
        }
      }
    }
  },
);

it.prop("an unknown node has an empty chain", [Shape], ([shape]) => {
  const trace = build(shape);
  for (const node of [taskNode("t999"), sectionNode("spec.nowhere"), sectionNode("prd.nowhere")]) {
    const chain = chainOf(trace, node);
    expect(chain.prd.size + chain.spec.size + chain.tasks.size).toBe(0);
    expect(isInChain(chain, node)).toBe(false);
  }
});

const ids = (set: ReadonlySet<string>) => Array.sort(set, Order.String);

it("a hand-built trace links PRD, spec and tasks one hop through spec sections", () => {
  const trace = build({
    specs: [[0], [0, 1], []],
    tasks: [
      { prd: [2], spec: [0] },
      { prd: [1], spec: [2] },
      { prd: [3], spec: [3] },
    ],
  });
  const prd0 = chainOf(trace, sectionNode(prdId(0)));
  expect(ids(prd0.spec)).toEqual(["spec.s0", "spec.s1"]);
  expect(ids(prd0.tasks)).toEqual(["t0"]);
  expect(ids(prd0.prd)).toEqual(["prd.p0"]);

  const task1 = chainOf(trace, taskNode("t1"));
  expect(ids(task1.prd)).toEqual(["prd.p1"]);
  expect(ids(task1.spec)).toEqual(["spec.s2"]);

  const spec1 = chainOf(trace, sectionNode(specId(1)));
  expect(ids(spec1.prd)).toEqual(["prd.p0", "prd.p1"]);
  expect(ids(spec1.tasks)).toEqual([]);

  const task0 = chainOf(trace, taskNode("t0"));
  expect(ids(task0.prd)).toEqual(["prd.p0", "prd.p2"]);
});
