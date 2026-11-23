import { SectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, HashSet, Number, Option, Record, Result, Schema, Struct } from "effect";
import {
  Subscription,
  all,
  click,
  expect,
  expectAll,
  expectHandled,
  expectIgnored,
  given,
  hover,
  keydown,
  role,
  scene,
  selector,
} from "foldkit/scene";
import * as simulate from "foldkit/scene";
import { Lazy } from "foldkit/test";
import { modifyFields } from "foldkit/struct";

import { VIEWPORT_ATTRIBUTE, viewportAttribute } from "../src/canvas.ts";
import { curvesOf } from "../src/curves.ts";
import { demoTrace } from "../src/demo.ts";
import { Movable, OFFSETS_ATTRIBUTE, offsetsAttribute } from "../src/drag.ts";
import type { Positions } from "../src/geometry.ts";
import { HOVER_FILL, PIN_PALETTE, SEARCH_FILL } from "../src/highlight.ts";
import { Message } from "../src/message.ts";
import { Drawer, type Model } from "../src/model.ts";
import { searchTrace } from "../src/search.ts";
import { columnOf, stackLayoutOf } from "../src/stacks.ts";
import { chainOf, isInChain, nodeKeyOf, type Chain, type Node } from "../src/trace.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import {
  focusedDrawerHeading,
  focusedSearchInput,
  loaded,
  mounted,
  mountedWith,
  scrolledSearchResult,
  sequence,
  taskButton,
} from "./fixtures.ts";

const sectionNode = (id: string) => ({
  id: Schema.decodeSync(SectionId)(id),
  kind: "section" as const,
});
const taskNode = (id: string) => ({ id: TaskId.make(id), kind: "task" as const });

const stackOrder = sectionNode("spec.planning.stack-order");
const judgments = sectionNode("spec.contract.judgments");
const trailers = sectionNode("spec.contract.trailers");
const t9 = taskNode("t9");
const t20 = taskNode("t20");
const t55 = taskNode("t55");
const t67 = taskNode("t67");

const searchBox = role("combobox", { name: "Search sections and tasks" });
const status = selector("[data-search-status]");
const option = (node: Node) => selector(`[data-search-result="${nodeKeyOf(node)}"]`);
const optionId = (node: Node) => `search-option-${nodeKeyOf(node)}`;
const card = (id: string) => selector(`[data-task="${id}"]`);
const heading = (id: string) => selector(`[data-section="${id}"]`);
const canvas = selector("[data-canvas]");
const layer = selector("[data-canvas-layer]");
const drawer = role("complementary");

/** Typing sends the input's whole text, as the browser's input event does. */
const typed = (query: string) => simulate.type(searchBox, query);
const pressed = (key: string) => keydown(searchBox, key);

const sizeOf = (nodes: Chain) =>
  Number.sumAll(Array.map([nodes.prd, nodes.spec, nodes.tasks], HashSet.size));
// Every PRD section, spec section and task is a node.
const nodeCount = Number.sumAll([
  demoTrace.prd.sections.length,
  demoTrace.spec.sections.length,
  demoTrace.tasks.length,
]);

/** Exactly the chain of `node` is highlighted and every other node is dimmed. */
const chainLit = (node: Node) => {
  const chain = chainOf(demoTrace, node);
  return [
    expectAll(all.selector("[data-highlighted]")).toHaveCount(sizeOf(chain)),
    expectAll(all.selector("[data-dimmed]")).toHaveCount(nodeCount - sizeOf(chain)),
  ];
};

const nothingLit = [
  expectAll(all.selector("[data-highlighted]")).toBeEmpty(),
  expectAll(all.selector("[data-dimmed]")).toBeEmpty(),
  expectAll(all.selector("[data-searched]")).toBeEmpty(),
];

it("an abbreviation lists ranked results with their kind, title and matched field, and marks them", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(searchBox).toHaveAttr("aria-expanded", "false"),
    expect(status).toHaveText(""),
    typed("stkord"),
    scrolledSearchResult,
    expect(searchBox).toHaveAttr("aria-expanded", "true"),
    expect(status).toHaveText("2 results."),
    expectAll(all.selector("[data-search-result]")).toHaveCount(2),
    expect(role("listbox", { name: "Search results" })).toExist(),
    expect(option(stackOrder)).toHaveAttr("role", "option"),
    expect(option(stackOrder)).toContainText("Spec"),
    expect(option(stackOrder)).toContainText("Stack order"),
    expect(simulate.within(option(stackOrder), selector("[data-search-field]"))).toHaveText(
      "title",
    ),
    expect(option(t20)).toContainText("Task"),
    expect(simulate.within(option(t20), selector("[data-search-field]"))).toHaveText(
      "branch: cairn-mvp/20-stack-order",
    ),
    // On the canvas the matched title, task id and branch carry marks; an unmatched card has none.
    expect(selector('[data-section="spec.planning.stack-order"] [data-search-match]')).toExist(),
    expect(selector('[data-task="t20"] [data-field="branch"] [data-search-match]')).toExist(),
    expect(selector('[data-task="t9"] [data-search-match]')).toBeAbsent(),
    expect(heading(stackOrder.id)).toHaveAttr("data-searched", "active"),
    expect(card("t20")).toHaveAttr("data-searched", "match"),
  );
});

it("a typo marks the matched word, and an exact id marks the id", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("judgmnt"),
    scrolledSearchResult,
    expect(status).toHaveText("3 results."),
    expect(selector('[data-section="spec.contract.judgments"] [data-search-match]')).toHaveText(
      "Judgment",
    ),
    typed("t55"),
    scrolledSearchResult,
    expect(selector('[data-task="t55"] strong [data-search-match]')).toHaveText("t55"),
    expect(selector('[data-task="t55"] [data-field="branch"] [data-search-match]')).toBeAbsent(),
  );
});

it("the arrow keys move through the results and stop at both ends; Enter selects", () => {
  const union = Struct.evolve(chainOf(demoTrace, judgments), {
    spec: (spec) => HashSet.union(spec, chainOf(demoTrace, t67).spec),
    tasks: (tasks) => HashSet.union(tasks, chainOf(demoTrace, t67).tasks),
  });
  assert(sizeOf(union)).toBeGreaterThan(sizeOf(chainOf(demoTrace, judgments)));
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("judgmnt"),
    scrolledSearchResult,
    // A new query starts at its first result, and only that result's chain is lit.
    expect(searchBox).toHaveAttr("aria-activedescendant", optionId(judgments)),
    expect(option(judgments)).toHaveAttr("aria-selected", "true"),
    expect(heading(judgments.id)).toHaveAttr("data-searched", "active"),
    ...chainLit(judgments),
    pressed("ArrowUp"),
    expectHandled(),
    scrolledSearchResult,
    expect(option(judgments)).toHaveAttr("aria-selected", "true"),
    pressed("ArrowDown"),
    expectHandled(),
    scrolledSearchResult,
    expect(searchBox).toHaveAttr("aria-activedescendant", optionId(t67)),
    expect(option(t67)).toHaveAttr("aria-selected", "true"),
    expect(option(judgments)).toHaveAttr("aria-selected", "false"),
    expect(card("t67")).toHaveAttr("data-searched", "active"),
    expect(heading(judgments.id)).toHaveAttr("data-searched", "match"),
    ...chainLit(t67),
    pressed("ArrowDown"),
    scrolledSearchResult,
    pressed("ArrowDown"),
    scrolledSearchResult,
    expect(searchBox).toHaveAttr("aria-activedescendant", optionId(t55)),
    ...chainLit(t55),
    pressed("Enter"),
    expectHandled(),
    expect(searchBox).toHaveAttr("aria-activedescendant", optionId(t55)),
  );
});

it("a click on a result selects it without pinning, opening the drawer or moving focus out of search", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("judgmnt"),
    scrolledSearchResult,
    click(option(t55)),
    focusedSearchInput,
    expect(option(t55)).toHaveAttr("aria-selected", "true"),
    expect(card("t55")).toHaveAttr("data-searched", "active"),
    ...chainLit(t55),
    expectAll(all.selector("[data-pins]")).toBeEmpty(),
    expect(role("button", { name: "Clear pins" })).toBeDisabled(),
    expect(drawer).toBeAbsent(),
  );
});

it("search, hover and several pins coexist, and clearing keeps the pins and the drawer", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    click(taskButton(t9.id)),
    focusedDrawerHeading,
    click(taskButton(t55.id)),
    focusedDrawerHeading,
    typed("trailer"),
    scrolledSearchResult,
    expect(heading(trailers.id)).toHaveAttr("data-searched", "active"),
    // t9 is in the search chain and in the first pin's: the search fill sits over the pin's stripe.
    expect(card("t9")).toHaveStyle("background", SEARCH_FILL),
    expect(card("t9")).toHaveStyle("box-shadow", `inset 4px 0 0 ${PIN_PALETTE.blue.stroke}`),
    // t55 is only pinned: it keeps its pin's fill and is not dimmed.
    expect(card("t55")).toHaveStyle("background", PIN_PALETTE.rose.fill),
    expect(card("t55")).toHaveAttr("data-highlighted", "true"),
    // Hovering is the top preview, and the stripe stays.
    hover(card("t9")),
    expect(card("t9")).toHaveStyle("background", HOVER_FILL),
    expect(card("t9")).toHaveStyle("box-shadow", `inset 4px 0 0 ${PIN_PALETTE.blue.stroke}`),
    simulate.expect(selector("[data-search]")).toExist(),
    Subscription.emit(Message.LeftNode()),
    expect(card("t9")).toHaveStyle("background", SEARCH_FILL),
    pressed("Escape"),
    expectHandled(),
    expect(searchBox).toHaveValue(""),
    expect(status).toHaveText(""),
    expectAll(all.selector("[data-search-result]")).toBeEmpty(),
    expectAll(all.selector("[data-search-match]")).toBeEmpty(),
    expectAll(all.selector("[data-searched]")).toBeEmpty(),
    expect(card("t9")).toHaveStyle("background", PIN_PALETTE.blue.fill),
    expect(card("t9")).toHaveAttr("data-pins", "blue"),
    expect(card("t55")).toHaveAttr("data-pins", "rose"),
    expect(role("button", { name: "Clear pins (2)" })).toExist(),
    expect(drawer).toExist(),
  );
});

it("emptying the query clears the search the same way", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("t43"),
    scrolledSearchResult,
    expect(card("t43")).toHaveAttr("data-searched", "active"),
    typed(""),
    ...nothingLit,
    expectAll(all.selector("[data-search-result]")).toBeEmpty(),
    expect(status).toHaveText(""),
  );
});

it("a query with no matches says so and leaves the canvas usable", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("zzzz"),
    expect(status).toHaveText("No results."),
    expect(searchBox).toHaveAttr("aria-expanded", "false"),
    expect(role("listbox")).toBeAbsent(),
    ...nothingLit,
    pressed("ArrowDown"),
    expectHandled(),
    pressed("Enter"),
    expectHandled(),
    click(taskButton(t9.id)),
    focusedDrawerHeading,
    expect(card("t9")).toHaveAttr("data-pins", "blue"),
    expect(drawer).toExist(),
  );
});

it("a new query scrolls the list back to its first result", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("judgmnt"),
    scrolledSearchResult,
    pressed("ArrowDown"),
    scrolledSearchResult,
    pressed("ArrowDown"),
    scrolledSearchResult,
    expect(option(t55)).toHaveAttr("aria-selected", "true"),
    // Editing the query makes the first result active, and the list is scrolled to it.
    typed("trailer"),
    scrolledSearchResult,
    expect(option(trailers)).toHaveAttr("aria-selected", "true"),
    // A query with no results has nothing to scroll to.
    typed("zzzz"),
    expect(status).toHaveText("No results."),
  );
});

it("keys other than the arrows, Enter and Escape are left to the input", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("t43"),
    scrolledSearchResult,
    pressed("a"),
    expectIgnored(),
    pressed("Tab"),
    expectIgnored(),
    expect(card("t43")).toHaveAttr("data-searched", "active"),
  );
});

const withoutTasks = (ids: ReadonlyArray<string>) =>
  Struct.evolve(demoTrace, {
    tasks: (tasks) => Array.filter(tasks, (task) => !Array.contains(ids, task.id)),
  });
const refreshedWith = (trace: typeof demoTrace) =>
  Subscription.emit(Message.SettledLoadTrace({ result: Result.succeed(trace) }));

it("a refresh keeps the active result while it matches and moves on when it is removed", () => {
  const fresh = Struct.evolve(demoTrace, {
    tasks: (tasks) =>
      Array.map(tasks, (task) => Struct.evolve(task, { status: () => "failed" as const })),
  });
  const trace = withoutTasks(["t67"]);
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("judgmnt"),
    scrolledSearchResult,
    pressed("ArrowDown"),
    scrolledSearchResult,
    // Only statuses changed, so t67 is still the active result.
    refreshedWith(fresh),
    expect(option(t67)).toHaveAttr("aria-selected", "true"),
    expect(card("t67")).toHaveAttr("data-searched", "active"),
    // t67 is gone: its result and its marks go, and the first result is active.
    refreshedWith(trace),
    expect(card("t67")).toBeAbsent(),
    expect(option(t67)).toBeAbsent(),
    expect(status).toHaveText("2 results."),
    expect(option(judgments)).toHaveAttr("aria-selected", "true"),
    expectAll(all.selector("[data-highlighted]")).toHaveCount(sizeOf(chainOf(trace, judgments))),
  );
});

it("a refresh that removes every match leaves no marks, outline or chain", () => {
  const trace = Struct.evolve(withoutTasks(["t55", "t67"]), {
    spec: (document) =>
      Struct.evolve(document, {
        sections: (sections) => Array.filter(sections, (section) => section.id !== judgments.id),
      }),
  });
  assert(searchTrace(trace, "judgmnt")).toEqual([]);
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("judgmnt"),
    scrolledSearchResult,
    refreshedWith(trace),
    expect(status).toHaveText("No results."),
    expectAll(all.selector("[data-search-match]")).toBeEmpty(),
    ...nothingLit,
  );
});

// Scene tests cannot lay anything out, so give each node a box.
const centerOf = { height: 80, width: 200, x: 1000, y: 400 };
const open = Drawer.Open({ maybeCommitSha: Option.none(), node: judgments });
const zoomed = modifyFields(loaded, {
  drawer: () => open,
  viewport: () => ({ x: 0, y: 0, zoom: 0.5 }),
});
const pointerId = 7;
const dragged = [
  Subscription.emit(
    Message.PressedMoveHandle({
      movable: Movable.Task({ id: t9.id }),
      pointer: { x: 100, y: 100 },
      pointerId,
    }),
  ),
  Subscription.emit(
    Message.MovedDragPointer({ buttons: 1, pointer: { x: 110, y: 120 }, pointerId }),
  ),
  Subscription.emit(Message.ReleasedDragPointer({ pointerId })),
];
/** The layer's mount measuring t9 where the layout put it, plus the card's offset. */
const measuredT9At = (x: number, y: number) =>
  Subscription.emit(
    Message.MeasuredLayout({ positions: { t9: { ...centerOf, x, y } } satisfies Positions }),
  );

it("selecting centres the node between the toolbar and the drawer at the current zoom", () => {
  scene(
    { update, view },
    given(zoomed),
    mounted,
    ...dragged,
    // The drag moved the card by 20 and 40 canvas units: 10 and 20 pixels at half zoom.
    expect(layer).toHaveAttr(OFFSETS_ATTRIBUTE, offsetsAttribute({ "task:t9": { x: 20, y: 40 } })),
    typed("trailer-schema"),
    scrolledSearchResult,
    expect(option(t9)).toHaveAttr("aria-selected", "true"),
    pressed("Enter"),
    // The layout has not measured the card, so the canvas waits where it is.
    expect(canvas).toHaveAttr(VIEWPORT_ATTRIBUTE, viewportAttribute({ x: 0, y: 0, zoom: 0.5 })),
    measuredT9At(1020, 440),
    // The pane is 1200 by 600; the toolbar covers 372 on the left and the drawer 420 on the
    // right, so the card's centre (1120, 480) goes to (576, 300).
    expect(canvas).toHaveAttr(VIEWPORT_ATTRIBUTE, viewportAttribute({ x: 16, y: 60, zoom: 0.5 })),
    // It centred once; a later measurement does not pull the canvas back.
    measuredT9At(2020, 840),
    expect(canvas).toHaveAttr(VIEWPORT_ATTRIBUTE, viewportAttribute({ x: 16, y: 60, zoom: 0.5 })),
    // Clicking the result centres on the card where it is now, and clearing keeps the viewport.
    click(option(t9)),
    focusedSearchInput,
    expect(canvas).toHaveAttr(
      VIEWPORT_ATTRIBUTE,
      viewportAttribute({ x: -484, y: -140, zoom: 0.5 }),
    ),
    pressed("Escape"),
    expect(canvas).toHaveAttr(
      VIEWPORT_ATTRIBUTE,
      viewportAttribute({ x: -484, y: -140, zoom: 0.5 }),
    ),
    expect(drawer).toExist(),
  );
});

it("only the lit chain's curves are drawn, and the unrelated ones stay unlit", () => {
  const boxes: Positions = Record.fromEntries(
    Array.map(
      Array.flatten<ReadonlyArray<ReadonlyArray<string>>>([
        Array.map(demoTrace.prd.sections, (section) => section.id),
        Array.map(demoTrace.spec.sections, (section) => section.id),
        Array.map(demoTrace.tasks, (task) => task.id),
      ]),
      (key, index) =>
        [
          key,
          { height: 20, width: 100, x: (index % 7) * 130, y: Math.floor(index / 7) * 60 },
        ] as const,
    ),
  );
  const chain = chainOf(demoTrace, judgments);
  const inChain = Array.filter(
    curvesOf(demoTrace, boxes, columnOf(stackLayoutOf(demoTrace.tasks))),
    (curve) => isInChain(chain, curve.source) && isInChain(chain, curve.target),
  );
  assert(Array.isReadonlyArrayNonEmpty(inChain)).toBe(true);
  scene(
    { update, view },
    given(loaded),
    mountedWith(boxes),
    expect(selector("[data-edge]")).toBeAbsent(),
    typed("judgmnt"),
    scrolledSearchResult,
    expectAll(all.selector("[data-edge]")).toHaveCount(inChain.length),
    expect(selector("[data-edge]:not([data-highlighted])")).toBeAbsent(),
    expect(selector("[data-edge][data-dimmed]")).toBeAbsent(),
    pressed("Escape"),
    expect(selector("[data-edge]")).toBeAbsent(),
  );
});

// The same trace and queries drive the property tests through update alone.
const queriedTo = (model: Model, query: string): Model =>
  update(model, Message.ChangedSearchQuery({ query })).model;

it.prop(
  "a new query makes the first result active, or nothing when there is none",
  {
    query: Schema.String,
  },
  ({ query }) => {
    const { search } = queriedTo(loaded, query);
    assert(search.maybeActive).toEqual(
      Option.map(Array.head(search.results), (first) => first.node),
    );
    assert(search.results).toEqual(searchTrace(demoTrace, query));
  },
);

it.prop(
  "the arrow keys keep the active result on the list and stop at its ends",
  {
    downs: Schema.Array(Schema.Boolean),
  },
  ({ downs }) => {
    const start = queriedTo(loaded, "judgmnt");
    const last = Array.length(start.search.results) - 1;
    const final = Array.reduce(
      downs,
      start,
      (model, isDown) =>
        update(model, isDown ? Message.PressedSearchArrowDown() : Message.PressedSearchArrowUp())
          .model,
    );
    const expected = Array.reduce(downs, 0, (index, isDown) =>
      Number.clamp(index + (isDown ? 1 : -1), { maximum: last, minimum: 0 }),
    );
    assert(final.search.maybeActive).toEqual(
      Option.map(Array.get(start.search.results, expected), (result) => result.node),
    );
  },
);

it("a result that is not on the list cannot be selected", () => {
  const start = queriedTo(loaded, "judgmnt");
  assert(update(start, Message.ClickedSearchResult({ node: t20 })).model).toEqual(start);
});

const frame = (x: number, model: Model) =>
  modifyFields(model, { viewport: () => ({ x, y: x, zoom: 1 + x }) });

it("a pan reuses the columns while a search is active, and so does a query that finds the same", () => {
  const searched = queriedTo(loaded, "judgmnt");
  assert(() =>
    Lazy.expectAllReused({
      model: searched,
      view: sequence([frame(0, searched), frame(1, searched)]),
    }),
  ).not.toThrow();
  const none = queriedTo(loaded, "zzzz");
  assert(() =>
    Lazy.expectAllReused({ model: none, view: sequence([none, queriedTo(none, "zzzzz")]) }),
  ).not.toThrow();
  assert(() =>
    Lazy.expectAllReused({ model: none, view: sequence([searched, queriedTo(loaded, "trailer")]) }),
  ).toThrow("ArgumentsChanged");
});
