import { SectionId, Trace, TraceJudgment, Verdict, type JudgmentTarget } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, HashSet, Number, Option, Order, Schema, Struct } from "effect";

import { demoTrace } from "../src/demo.ts";
import { Node, chainOf, isInChain, judgmentMarkOf, sectionStatusOf } from "../src/trace.ts";

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
    prd: { markdown: "", path: "prd.md", sections: Array.map(prdIds, (id) => section(id, [])) },
    sections: [],
    spec: {
      markdown: "",
      path: "spec.md",
      sections: Array.map(specIds, (id, n) =>
        section(
          id,
          Array.map(
            Option.getOrElse(Array.get(shape.specs, n), () => []),
            (p) => prdId(p),
          ),
        ),
      ),
    },
    tasks: Array.map(shape.tasks, (task, n) => ({
      ...taskBase,
      id: `t${n}`,
      prdSections: Array.map(task.prd, (p) => prdId(p)),
      specSections: Array.map(task.spec, (s) => specId(s)),
    })),
    version: 1,
    warnings: [],
  });

const decodeNode = Schema.decodeUnknownSync(Node);
const sectionNode = (id: string) => decodeNode({ id, kind: "section" });
const taskNode = (id: string) => decodeNode({ id, kind: "task" });

const nodesOf = (trace: Trace): ReadonlyArray<Node> =>
  Array.flatten([
    Array.map(trace.prd.sections, (s) => sectionNode(s.id)),
    Array.map(trace.spec.sections, (s) => sectionNode(s.id)),
    Array.map(trace.tasks, (task) => taskNode(task.id)),
  ]);

it.prop("a node is in its own chain", [Shape], ([shape]) => {
  const trace = build(shape);
  Array.forEach(nodesOf(trace), (node) => {
    expect(isInChain(chainOf(trace, node), node)).toBe(true);
  });
});

it.prop(
  "links are symmetric between sections and tasks and between PRD and spec",
  [Shape],
  ([shape]) => {
    const trace = build(shape);
    const nodes = nodesOf(trace);
    Array.forEach(Array.cartesian(nodes, nodes), ([a, b]) => {
      if (isInChain(chainOf(trace, a), b)) {
        expect(isInChain(chainOf(trace, b), a)).toBe(true);
      }
    });
  },
);

it.prop("an unknown node has an empty chain", [Shape], ([shape]) => {
  const trace = build(shape);
  Array.forEach(
    [taskNode("t999"), sectionNode("spec.nowhere"), sectionNode("prd.nowhere")],
    (node) => {
      const chain = chainOf(trace, node);
      expect(Number.sumAll(Array.map([chain.prd, chain.spec, chain.tasks], HashSet.size))).toBe(0);
      expect(isInChain(chain, node)).toBe(false);
    },
  );
});

const ids = (set: HashSet.HashSet<string>) => Array.sort(set, Order.String);

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

it("sectionStatusOf finds each rolled-up section and nothing for an unknown one", () => {
  Array.forEach(demoTrace.sections, (rolled) => {
    expect(sectionStatusOf(demoTrace, rolled.id)).toEqual(Option.some(rolled.status));
  });
  expect(sectionStatusOf(demoTrace, SectionId.make("spec.nowhere"))).toEqual(Option.none());
});

const judgment = (verdict: Verdict, stale: boolean, target: typeof JudgmentTarget.Encoded) =>
  Schema.decodeSync(TraceJudgment)({
    action: "none",
    answer: { probability: 0.5 },
    at: "2026-01-01T00:00:00.000Z",
    inputHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    message: "m",
    question: "size",
    round: 1,
    stale,
    target,
    verdict,
  });

const Marks = Schema.Array(Schema.Struct({ stale: Schema.Boolean, verdict: Verdict }));

it.prop(
  "a node's mark is its worst judgment that is not a pass, fresh ahead of stale",
  [Marks],
  ([marks]) => {
    const trace = Struct.evolve(build({ specs: [[0]], tasks: [{ prd: [0], spec: [0] }] }), {
      judgments: () =>
        Array.appendAll(
          Array.map(marks, ({ stale, verdict }) =>
            judgment(verdict, stale, { id: "t0", kind: "task" }),
          ),
          // Judgments of other targets never mark t0.
          [
            judgment("flag", false, { id: "t1", kind: "task" }),
            judgment("flag", false, { id: specId(0), kind: "section" }),
            judgment("flag", false, { kind: "stack" }),
          ],
        ),
    });
    const counted = Array.filter(marks, (mark) => mark.verdict !== "pass");
    Option.match(judgmentMarkOf(trace, taskNode("t0")), {
      onNone: () => expect(counted).toEqual([]),
      onSome: (mark) => {
        expect(mark.verdict).toBe(
          Array.some(counted, (m) => m.verdict === "flag") ? "flag" : "unsure",
        );
        expect(mark.stale).toBe(
          !Array.some(counted, (m) => m.verdict === mark.verdict && !m.stale),
        );
      },
    });
  },
);
