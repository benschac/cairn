import {
  ParticipantId,
  TraceJudgment,
  Verdict,
  type JudgmentTarget,
  type SectionId,
  type TaskId,
} from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Number, Option, Record, Schema, Struct } from "effect";
import { Subscription, expect, given, role, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { Message, init, update, view } from "../src/main.ts";
import { TraceData } from "../src/model.ts";
import { stackLayoutOf } from "../src/stacks.ts";
import { sectionStatusOf } from "../src/trace.ts";

const loaded = modifyFields(init().model, {
  trace: () => TraceData.Success({ data: demoTrace }),
});
const status = (id: SectionId) => Option.getOrThrow(sectionStatusOf(demoTrace, id));
const task = (id: string) => selector(`[data-task="${id}"]`);
const hasStatus = (section: { readonly id: SectionId }) =>
  Option.isSome(sectionStatusOf(demoTrace, section.id));

it("the trace shows as PRD, spec and stack columns", () => {
  scene(
    { update, view },
    given(loaded),
    expect(selector('[data-column="prd"]')).toExist(),
    expect(selector('[data-column="spec"]')).toExist(),
    expect(selector('[data-column="stacks"]')).toExist(),
    expect(selector('[data-column="prd"] [data-task]')).toBeAbsent(),
    expect(selector('[data-column="stacks"] [data-task]')).toExist(),
  );
});

it("a PRD heading and a spec heading carry their rollup badge", () => {
  const { prd, spec } = Option.getOrThrow(
    Option.all({
      prd: Array.findFirst(demoTrace.prd.sections, hasStatus),
      spec: Array.findFirst(demoTrace.spec.sections, hasStatus),
    }),
  );
  scene(
    { update, view },
    given(loaded),
    expect(selector(`[data-section="${prd.id}"] [data-badge]`)).toHaveAttr(
      "data-status",
      status(prd.id),
    ),
    expect(selector(`[data-section="${spec.id}"] [data-badge]`)).toHaveAttr(
      "data-status",
      status(spec.id),
    ),
  );
});

it("task t9 shows its branch, model and status", () => {
  scene(
    { update, view },
    given(loaded),
    expect(task("t9")).toContainText("cairn-mvp/09-trailer-schema"),
    expect(task("t9")).toContainText("sonnet"),
    expect(selector('[data-task="t9"] [data-status]')).toHaveAttr("data-status", "done"),
    expect(selector('[data-task="t9"] [data-status]')).toHaveText("done"),
    expect(selector('[data-task="t9"] [data-gate]')).toBeAbsent(),
  );
});

it("a gated task shows the gate marker", () => {
  scene(
    { update, view },
    given(loaded),
    expect(selector('[data-task="t1"] [data-gate]')).toExist(),
  );
});

it("every task sits in a higher grid row than each of its dependencies", () => {
  const layout = stackLayoutOf(demoTrace.tasks);
  const top = Array.reduce(Record.values(layout), 1, (highest, position) =>
    Number.max(highest, position.row),
  );
  const at = (id: TaskId) => Option.getOrThrow(Record.get(layout, id));
  // Row 1 is the bottom of the stack, so a higher task has a smaller CSS grid row.
  const gridRow = (id: TaskId) => top - at(id).row + 1;
  const edges = Array.flatMap(demoTrace.tasks, (dependent) =>
    Array.map(dependent.dependsOn, (dependency) => ({ dependency, dependent: dependent.id })),
  );
  Array.forEach(edges, ({ dependency, dependent }) => {
    assert(gridRow(dependent)).toBeLessThan(gridRow(dependency));
  });
  // The view places each task where the layout says; one edge is enough to show that.
  const { dependency, dependent } = Option.getOrThrow(Array.head(edges));
  scene(
    { update, view },
    given(loaded),
    expect(task(dependent)).toHaveStyle("grid-row", String(gridRow(dependent))),
    expect(task(dependency)).toHaveStyle("grid-row", String(gridRow(dependency))),
    expect(task(dependent)).toHaveStyle("grid-column", String(at(dependent).column)),
  );
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

it("a flag or unsure judgment marks its task and section, dimmed when stale; a pass does not", () => {
  // Every verdict and staleness, each on its own task.
  const cases = Array.zipWith(
    demoTrace.tasks,
    Array.cartesian(Verdict.literals, [false, true]),
    (target, [verdict, stale]) => ({ id: target.id, stale, verdict }),
  );
  assert(cases).toHaveLength(6);
  const specId = Option.getOrThrow(Array.head(demoTrace.spec.sections)).id;
  const trace = Struct.evolve(demoTrace, {
    judgments: () =>
      Array.append(
        Array.map(cases, ({ id, stale, verdict }) =>
          judgment(verdict, stale, { id, kind: "task" }),
        ),
        judgment("flag", true, { id: specId, kind: "section" }),
      ),
  });
  scene(
    { update, view },
    given(modifyFields(loaded, { trace: () => TraceData.Success({ data: trace }) })),
    ...Array.flatMap(cases, ({ id, stale, verdict }) => {
      const mark = selector(`[data-task="${id}"] [data-judgment]`);
      return verdict === "pass"
        ? [expect(mark).toBeAbsent()]
        : [
            expect(mark).toHaveAttr("data-judgment", verdict),
            expect(mark).toHaveAttr("data-stale", String(stale)),
            expect(mark).toHaveStyle("opacity", stale ? "0.4" : "1"),
          ];
    }),
    expect(selector(`[data-section="${specId}"] [data-judgment="flag"]`)).toHaveAttr(
      "data-stale",
      "true",
    ),
  );
});

it("other participants appear with their cursors, and you do not", () => {
  scene(
    { update, view },
    given(loaded),
    expect(role("status")).toHaveText("Nobody else is here."),
    Subscription.emit(
      Message.ReceivedPresence({
        presence: {
          participants: [
            {
              cursor: Option.some({ x: 0.1, y: 0.1 }),
              id: ParticipantId.make("p1"),
              kind: "human",
              name: "Ada",
            },
            {
              cursor: Option.some({ x: 0.25, y: 0.5 }),
              id: ParticipantId.make("p2"),
              kind: "agent",
              name: "Planner",
            },
            { cursor: Option.none(), id: ParticipantId.make("p3"), kind: "human", name: "Grace" },
          ],
          you: ParticipantId.make("p1"),
        },
      }),
    ),
    expect(role("status")).toHaveText("Here now: Planner (agent), Grace"),
    expect(selector('[data-cursor="agent"]')).toHaveText("Planner (agent)"),
    expect(selector('[data-cursor="agent"]')).toHaveStyle("left", "25%"),
    expect(selector('[data-cursor="human"]')).toBeAbsent(),
  );
});
