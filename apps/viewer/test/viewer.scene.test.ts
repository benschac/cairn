import {
  TraceJudgment,
  Verdict,
  type JudgmentTarget,
  type SectionId,
  type TaskId,
} from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, HashSet, Number, Option, Record, Schema, Struct, pipe } from "effect";
import {
  Mount,
  Subscription,
  all,
  click,
  expect,
  expectAll,
  given,
  hover,
  role,
  scene,
  selector,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import {
  PanZoomCanvas,
  boundsOf,
  fitViewport,
  ORIGIN_VIEWPORT,
  transformOf,
  viewportAttribute,
} from "../src/canvas.ts";
import { curvesOf } from "../src/curves.ts";
import { demoTrace } from "../src/demo.ts";
import { MAX_ZOOM, MIN_ZOOM, Viewport, type Positions } from "../src/geometry.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/message.ts";
import { TraceData } from "../src/model.ts";
import { columnOf, stackLayoutOf } from "../src/stacks.ts";
import { chainOf, isInChain, sectionStatusOf, type Chain, type Node } from "../src/trace.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import { loaded, mounted, paneSize } from "./fixtures.ts";

const status = (id: SectionId) => Option.getOrThrow(sectionStatusOf(demoTrace, id));
const task = (id: string) => selector(`[data-task="${id}"]`);
const hasStatus = (section: { readonly id: SectionId }) =>
  Option.isSome(sectionStatusOf(demoTrace, section.id));

it("the trace shows as PRD, spec and stack columns", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
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
    mounted,
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
    mounted,
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
    mounted,
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
    mounted,
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
    mounted,
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

// A spec section whose chain has tasks and PRD sections, and a task outside that chain.
const { chain, specSection, unrelated } = Option.getOrThrow(
  Array.findFirst(demoTrace.spec.sections, (section) => {
    const node: Node = { id: section.id, kind: "section" };
    const sectionChain = chainOf(demoTrace, node);
    return pipe(
      Array.findFirst(
        demoTrace.tasks,
        (candidate) => !HashSet.has(sectionChain.tasks, candidate.id),
      ),
      Option.filter(
        () => !HashSet.isEmpty(sectionChain.tasks) && !HashSet.isEmpty(sectionChain.prd),
      ),
      Option.map((outside) => ({ chain: sectionChain, specSection: node, unrelated: outside.id })),
    );
  }),
);
const heading = (id: string) => selector(`[data-section="${id}"]`);
const firstOf = (ids: HashSet.HashSet<string>) =>
  Option.getOrThrow(Array.head(Array.fromIterable(ids)));
const chainTask = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (candidate) => HashSet.has(chain.tasks, candidate.id)),
).id;
const chainPrd = firstOf(chain.prd);
// foldkit/scene has hover but no step for the mouse leaving, so send what OnMouseLeave sends.
const left = Subscription.emit(Message.LeftNode());
const highlighted = (target: ReturnType<typeof selector>) =>
  expect(target).toHaveAttr("data-highlighted", "true");
const sizeOf = (nodes: Chain) =>
  Number.sumAll(Array.map([nodes.prd, nodes.spec, nodes.tasks], HashSet.size));
// Every PRD section, spec section and task is a node.
const nodeCount = Number.sumAll([
  demoTrace.prd.sections.length,
  demoTrace.spec.sections.length,
  demoTrace.tasks.length,
]);

it("hovering a spec section highlights exactly its chain and dims the rest; leaving clears", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expectAll(all.selector("[data-dimmed]")).toBeEmpty(),
    hover(heading(specSection.id)),
    highlighted(heading(specSection.id)),
    highlighted(task(chainTask)),
    highlighted(heading(chainPrd)),
    expect(task(unrelated)).toHaveAttr("data-dimmed", "true"),
    expect(selector(`[data-task="${unrelated}"][data-highlighted]`)).toBeAbsent(),
    expectAll(all.selector("[data-highlighted]")).toHaveCount(sizeOf(chain)),
    expectAll(all.selector("[data-dimmed]")).toHaveCount(nodeCount - sizeOf(chain)),
    left,
    expectAll(all.selector("[data-highlighted]")).toBeEmpty(),
    expectAll(all.selector("[data-dimmed]")).toBeEmpty(),
  );
});

it("hovering a task highlights its sections", () => {
  const expected = chainOf(demoTrace, { id: chainTask, kind: "task" });
  assert(HashSet.isEmpty(expected.spec)).toBe(false);
  scene(
    { update, view },
    given(loaded),
    mounted,
    hover(task(chainTask)),
    highlighted(task(chainTask)),
    highlighted(heading(firstOf(expected.spec))),
    highlighted(heading(firstOf(expected.prd))),
    expectAll(all.selector("[data-highlighted]")).toHaveCount(sizeOf(expected)),
  );
});

it("clicking keeps the highlight after leaving, and clicking again clears it", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    hover(heading(specSection.id)),
    click(heading(specSection.id)),
    left,
    highlighted(task(chainTask)),
    expect(task(unrelated)).toHaveAttr("data-dimmed", "true"),
    // A leave with nothing hovered is ignored: the selection stays.
    left,
    highlighted(task(chainTask)),
    click(heading(specSection.id)),
    expectAll(all.selector("[data-highlighted]")).toBeEmpty(),
  );
});

it("hovering something else previews it over the selection", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    click(heading(specSection.id)),
    hover(task(unrelated)),
    highlighted(task(unrelated)),
    expect(task(chainTask)).toHaveAttr("data-dimmed", "true"),
    left,
    highlighted(task(chainTask)),
  );
});

// Scene tests cannot lay anything out, so give every node a box and let the curves follow.
const boxes: Positions = Record.fromEntries(
  Array.map(
    Array.flatten<ReadonlyArray<ReadonlyArray<string>>>([
      Array.map(demoTrace.prd.sections, (section) => section.id),
      Array.map(demoTrace.spec.sections, (section) => section.id),
      Array.map(demoTrace.tasks, (candidate) => candidate.id),
    ]),
    (key, index) =>
      [
        key,
        { height: 20, width: 100, x: (index % 7) * 130, y: Math.floor(index / 7) * 60 },
      ] as const,
  ),
);
const allCurves = curvesOf(demoTrace, boxes, columnOf(stackLayoutOf(demoTrace.tasks)));
const measured = Subscription.emit(Message.MeasuredLayout({ positions: boxes }));
const edge = (id: string) => selector(`[data-edge="${id}"]`);
// An edge counts as in the chain only when both of its ends are, so these straddle it.
const straddling = (sourceIn: boolean) =>
  Array.findFirst(
    allCurves,
    (curve) =>
      isInChain(chain, curve.source) === sourceIn && isInChain(chain, curve.target) !== sourceIn,
  );
const { dashedCurve, enteringChain, insideChain, leavingChain, outsideChain, solidCurve } =
  Option.getOrThrowWith(
    Option.all({
      dashedCurve: Array.findFirst(allCurves, (curve) => curve.dashed),
      enteringChain: straddling(false),
      leavingChain: straddling(true),
      insideChain: Array.findFirst(
        allCurves,
        (curve) => curve.kind === "specifies" && curve.source.id === specSection.id,
      ),
      outsideChain: Array.findFirst(
        allCurves,
        (curve) => curve.source.id === unrelated || curve.target.id === unrelated,
      ),
      solidCurve: Array.findFirst(allCurves, (curve) => curve.kind === "specifies"),
    }),
    () => new Error("the demo trace lacks the edges the curve scenes need"),
  );

it("the columns sit inside one canvas layer that also holds the edges", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(selector("[data-canvas] [data-canvas-layer]")).toExist(),
    expect(selector("[data-canvas-layer] [data-column]")).toExist(),
    expect(selector("[data-canvas-layer] [data-edges]")).toExist(),
    expect(selector("[data-edges]")).toHaveStyle("pointer-events", "none"),
  );
});

it("with nothing measured no edge is drawn", () => {
  scene({ update, view }, given(loaded), mounted, expect(selector("[data-edge]")).toBeAbsent());
});

it("measured nodes get a path per link, dashed only across columns", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    measured,
    expect(edge(solidCurve.id)).toHaveAttr("data-kind", solidCurve.kind),
    expect(edge(solidCurve.id)).toHaveAttr("d", solidCurve.path),
    expect(selector(`[data-edge="${solidCurve.id}"][stroke-dasharray]`)).toBeAbsent(),
    expect(edge(dashedCurve.id)).toHaveAttr("data-kind", "dependency"),
    expect(edge(dashedCurve.id)).toHaveAttr("stroke-dasharray", "6 4"),
    expect(selector("[data-edge][data-highlighted]")).toBeAbsent(),
    expect(selector("[data-edge][data-dimmed]")).toBeAbsent(),
  );
});

it("a measurement replaces the previous one, and edges to unmeasured nodes are not drawn", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    measured,
    expect(edge(solidCurve.id)).toExist(),
    Subscription.emit(Message.MeasuredLayout({ positions: {} })),
    expect(selector("[data-edge]")).toBeAbsent(),
  );
});

it("hovering a chain highlights its edges and dims the others; leaving clears", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    measured,
    hover(heading(specSection.id)),
    expect(edge(insideChain.id)).toHaveAttr("data-highlighted", "true"),
    expect(edge(outsideChain.id)).toHaveAttr("data-dimmed", "true"),
    expect(edge(outsideChain.id)).toHaveAttr("opacity", "0.15"),
    expect(edge(leavingChain.id)).toHaveAttr("data-dimmed", "true"),
    expect(edge(enteringChain.id)).toHaveAttr("data-dimmed", "true"),
    expect(edge(insideChain.id)).toHaveAttr("stroke-width", "2.5"),
    expect(selector(`[data-edge="${insideChain.id}"][data-dimmed]`)).toBeAbsent(),
    left,
    expect(selector("[data-edge][data-highlighted]")).toBeAbsent(),
    expect(selector("[data-edge][data-dimmed]")).toBeAbsent(),
  );
});

// Pan and zoom. The library runs in the pane's mount, which Scene cannot start, so a test answers
// for it with the message the library would send.
const layer = selector("[data-canvas-layer]");
const pane = selector("[data-canvas]");
const fit = role("button", { name: "Fit to view" });

it("the pane is mounted on and the layer starts at the origin viewport", () => {
  scene(
    { update, view },
    given(loaded),
    Mount.expectExact(PanZoomCanvas),
    mounted,
    expect(pane).toHaveStyle("overflow", "hidden"),
    expect(pane).toHaveAttr("data-viewport", viewportAttribute(ORIGIN_VIEWPORT)),
    expect(layer).toHaveStyle("transform", transformOf(ORIGIN_VIEWPORT)),
    expect(layer).toHaveStyle("transform-origin", "0 0"),
    expect(selector("[data-canvas] [data-canvas-layer] [data-edges]")).toExist(),
  );
});

it.prop(
  "a pan or zoom moves the layer and the pane's viewport attribute",
  { viewport: Viewport },
  ({ viewport }) => {
    scene(
      { update, view },
      given(loaded),
      Mount.resolve(PanZoomCanvas, Message.PannedOrZoomed({ viewport })),
      expect(layer).toHaveStyle("transform", transformOf(viewport)),
      expect(pane).toHaveAttr("data-viewport", viewportAttribute(viewport)),
    );
  },
  // Each run renders the whole demo trace, so a few runs cover it.
  { arbitrary: { runs: 10 }, timeout: 30_000 },
);

it("the pane does not mount before there is a trace to pan over", () => {
  scene(
    { update, view },
    given(init().model),
    expect(pane).toBeAbsent(),
    expect(fit).toBeAbsent(),
    Mount.expectNone(),
  );
});

it("clicking Fit sets the viewport that frames every measured node", () => {
  const fitted = fitViewport(Option.getOrThrow(boundsOf(boxes)), paneSize.width, paneSize.height);
  assert(fitted).not.toEqual(ORIGIN_VIEWPORT);
  assert(fitted.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
  assert(fitted.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  scene(
    { update, view },
    given(loaded),
    mounted,
    measured,
    click(fit),
    expect(layer).toHaveStyle("transform", transformOf(fitted)),
    expect(pane).toHaveAttr("data-viewport", viewportAttribute(fitted)),
  );
});

it("Fit does nothing until the nodes are measured and the pane has a size", () => {
  const panned: Viewport = { x: 5, y: 7, zoom: 1.5 };
  scene(
    { update, view },
    given(loaded),
    Mount.resolve(PanZoomCanvas, Message.PannedOrZoomed({ viewport: panned })),
    // No pane size yet, though the nodes are measured.
    measured,
    click(fit),
    expect(layer).toHaveStyle("transform", transformOf(panned)),
  );
  scene(
    { update, view },
    given(loaded),
    mounted,
    // The pane is sized, but nothing is measured.
    click(fit),
    expect(layer).toHaveStyle("transform", transformOf(ORIGIN_VIEWPORT)),
  );
});

it("a panned canvas keeps its nodes clickable and marked so a drag on them selects text", () => {
  scene(
    { update, view },
    given(loaded),
    Mount.resolve(
      PanZoomCanvas,
      Message.PannedOrZoomed({ viewport: { x: -300, y: 40, zoom: 0.5 } }),
    ),
    expect(task(chainTask)).toHaveClass("nopan"),
    expect(heading(specSection.id)).toHaveClass("nopan"),
    expect(pane).not.toHaveClass("nopan"),
    click(heading(specSection.id)),
    highlighted(task(chainTask)),
    expect(layer).toHaveStyle("transform", transformOf({ x: -300, y: 40, zoom: 0.5 })),
  );
});

it("nothing in the canvas scrolls or clips, so every node can be hovered and clicked", () => {
  const stacks = selector("[data-stacks]");
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(selector('[data-column="prd"]')).toHaveStyle("overflow", "visible"),
    expect(selector('[data-column="spec"]')).toHaveStyle("overflow", "visible"),
    expect(selector('[data-column="stacks"]')).toHaveStyle("overflow", "visible"),
    // The stacks grid is as wide as its columns, however many there are.
    expect(stacks).toHaveStyle("width", "max-content"),
    expect(layer).toHaveStyle("width", "max-content"),
    expect(selector("[data-column] pre")).toHaveStyle("white-space", "pre-wrap"),
  );
});
