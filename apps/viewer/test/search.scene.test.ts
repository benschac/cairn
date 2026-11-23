import { SectionId, TaskId, type Trace } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, HashSet, Option, Record, Result, Schema, String, Struct, pipe } from "effect";
import type { Document, HtmlBuilder } from "foldkit/html";
import {
  Command,
  Mount,
  Subscription,
  all,
  click,
  expect,
  expectAll,
  expectIgnored,
  given,
  hover,
  keydown,
  role,
  scene,
  selector,
  type,
  within,
} from "foldkit/scene";
import { Lazy } from "foldkit/test";
import { modifyFields } from "foldkit/struct";

import {
  PanZoomCanvas,
  TOOLBAR_MARGIN,
  VIEWPORT_ATTRIBUTE,
  TOOLBAR_WIDTH,
  toScreen,
  viewportAttribute,
} from "../src/canvas.ts";
import { FocusSearch, MeasureSearchBlock, ScrollSearchResult } from "../src/command.ts";
import { curvesOf } from "../src/curves.ts";
import { demoTrace } from "../src/demo.ts";
import { DRAWER_WIDTH } from "../src/drawer.ts";
import { Movable } from "../src/drag.ts";
import { MAX_ZOOM, MIN_ZOOM, Viewport, type Positions } from "../src/geometry.ts";
import { HOVER_FILL, PIN_PALETTE, SEARCH_FILL } from "../src/highlight.ts";
import { documentOf, treeOf } from "../src/markdown.ts";
import { Message } from "../src/message.ts";
import { Drawer, TraceData, type Model } from "../src/model.ts";
import { searchOptionIdOf, searchTrace, type SearchResult } from "../src/search.ts";
import { columnOf, stackLayoutOf } from "../src/stacks.ts";
import { Node, chainOf, isInChain, nodeKeyOf } from "../src/trace.ts";
import { update } from "../src/update.ts";
import { searchKeyMessageOf } from "../src/view/searchView.ts";
import { view } from "../src/view/view.ts";
import {
  focusedDrawerHeading,
  layerMountedWith,
  loaded,
  mounted,
  mountedWith,
  paneSize,
  sectionButton,
  taskButton,
} from "./fixtures.ts";

// Scene tests cannot lay anything out, so give every node a box.
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

const input = role("combobox", { name: "Search" });
const status = selector("[data-search-status]");
const options = all.role("option");
const canvas = selector("[data-canvas]");
const typed = (query: string) => type(input, query);
// A query with results scrolls the list to its first one, which the scene answers for.
const key = (name: string) => keydown(input, name);
const scrolled = Command.resolve(ScrollSearchResult, Message.CompletedScrollSearchResult());
const typedFindingResults = (query: string) => [typed(query), scrolled];
const refocused = Command.resolve(FocusSearch, Message.CompletedFocusSearch());

const elementOf = (node: Node) =>
  selector(node.kind === "section" ? `[data-section="${node.id}"]` : `[data-task="${node.id}"]`);
const optionOf = (node: Node) => selector(`[data-search-result="${node.id}"]`);
/** The marks of a result: in its own element, or in the paragraph or cell its prose match is. */
const marks = (node: Node) =>
  Option.match(
    Option.flatMap(
      Array.findFirst(results, (result) => nodeKeyOf(result.node) === nodeKeyOf(node)),
      (result) => (result.field === "prose" ? result.maybeBlock : Option.none()),
    ),
    {
      onNone: () => within(elementOf(node), selector("mark")),
      onSome: (block) => selector(`[data-block="${block}"] mark`),
    },
  );
const buttonOf = (node: Node) =>
  Node.match(node, {
    section: ({ id }) =>
      sectionButton(Array.some(demoTrace.prd.sections, (s) => s.id === id) ? "PRD" : "Spec", id),
    task: ({ id }) => taskButton(id),
  });

const sizeOf = (nodes: { prd: HashSet.HashSet<string>; spec: HashSet.HashSet<string> }) =>
  HashSet.size(nodes.prd) + HashSet.size(nodes.spec);

/** A typo of "redact" that ranks sections and tasks of several kinds. */
const QUERY = "redcat";
const results = searchTrace(demoTrace, QUERY);
const first = Option.getOrThrow(Array.get(results, 0));
const second = Option.getOrThrow(Array.get(results, 1));
const firstChain = chainOf(demoTrace, first.node);
const secondChain = chainOf(demoTrace, second.node);
const isResult = (node: Node) =>
  Array.some(results, (result) => nodeKeyOf(result.node) === nodeKeyOf(node));
const matchedText = (result: SearchResult) =>
  pipe(
    result.ranges,
    Array.map((range) => pipe(result.text, String.slice(range.start, range.end))),
    Array.join(""),
  );

/** A task in the first result's chain that the query did not match by itself. */
const chainOnly: Node = Option.getOrThrow(
  Array.findFirst(
    Array.map(demoTrace.tasks, (task): Node => ({ id: task.id, kind: "task" })),
    (node) => isInChain(firstChain, node) && !isResult(node),
  ),
);
/** A result outside the first result's chain. */
const outsideChain: Node = Option.getOrThrow(
  Array.findFirst(
    Array.map(results, (result) => result.node),
    (node) => !isInChain(firstChain, node),
  ),
);

/** Exactly the chain's sections and tasks are highlighted; the curves, if drawn, are not counted. */
/** A task that is neither a result nor in the first result's chain. */
const dimmedNode: Node = Option.getOrThrow(
  Array.findFirst(
    Array.map(demoTrace.tasks, (task): Node => ({ id: task.id, kind: "task" })),
    (node) => !isInChain(firstChain, node) && !isResult(node),
  ),
);

const litNodes = (chain: typeof firstChain) => [
  expectAll(all.selector("[data-section][data-highlighted]")).toHaveCount(sizeOf(chain)),
  expectAll(all.selector("[data-task][data-highlighted]")).toHaveCount(HashSet.size(chain.tasks)),
];

it("typing a typo ranks the results, marks the matched text and lights the first result's chain", () => {
  assert(results.length).toBeGreaterThan(2);
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(input).toHaveAttr("aria-expanded", "false"),
    expect(status).toHaveText(""),
    expectAll(options).toBeEmpty(),
    ...typedFindingResults(QUERY),
    expect(input).toHaveValue(QUERY),
    expect(input).toHaveAttr("aria-expanded", "true"),
    expect(input).toHaveAttr("aria-activedescendant", searchOptionIdOf(first.node)),
    expect(status).toHaveText(`${results.length} results`),
    expectAll(options).toHaveCount(results.length),
    expect(optionOf(first.node)).toHaveAttr("aria-selected", "true"),
    expect(optionOf(second.node)).toHaveAttr("aria-selected", "false"),
    // The result is described by kind, title and matched field.
    expect(optionOf(first.node)).toContainText("PRD"),
    expect(optionOf(first.node)).toContainText(first.text),
    expect(optionOf(first.node)).toContainText("title"),
    expect(within(optionOf(first.node), selector("mark"))).toHaveText(matchedText(first)),
    // The matched characters are marked on the canvas, in the node itself.
    expect(marks(first.node)).toHaveText(matchedText(first)),
    // The active result is outlined and labelled, the other results only marked.
    expectAll(all.selector('[data-search="active"]')).toHaveCount(1),
    expect(elementOf(first.node)).toHaveAttr("data-search", "active"),
    expect(elementOf(first.node)).toHaveStyle("outline", "3px solid #1c1917"),
    expectAll(all.selector('[data-search="match"]')).toHaveCount(results.length - 1),
    expect(elementOf(second.node)).toHaveAttr("data-search", "match"),
    // Its chain is highlighted as any chain is, with the search's fill.
    expect(elementOf(first.node)).toHaveStyle("background", SEARCH_FILL),
    ...litNodes(firstChain),
    // A chain member nothing matched is lit without marks or an outline.
    expect(elementOf(chainOnly)).toHaveAttr("data-highlighted", "true"),
    expect(elementOf(chainOnly)).toHaveAttr("data-search-chain", "true"),
    expect(elementOf(chainOnly)).not.toHaveAttr("data-search"),
    expect(marks(chainOnly)).toBeAbsent(),
    // A result outside the chain keeps its marks and is not dimmed with the rest.
    expect(elementOf(outsideChain)).toHaveAttr("data-search", "match"),
    expect(elementOf(outsideChain)).not.toHaveAttr("data-dimmed"),
    expect(elementOf(outsideChain)).not.toHaveStyle("opacity", "0.35"),
    // Anything that is neither a result nor in the chain is dimmed, as for any lit chain.
    expect(elementOf(dimmedNode)).toHaveAttr("data-dimmed", "true"),
    expect(elementOf(dimmedNode)).toHaveStyle("opacity", "0.35"),
    expect(marks(outsideChain)).toExist(),
    // The node buttons keep their names, marks and all.
    expect(buttonOf(first.node)).toExist(),
  );
});

it("arrow keys move the active result and its chain, bounded at the ends, and Enter keeps focus where it is", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    ...typedFindingResults(QUERY),
    // The first result is already the first, so Up stays and does nothing.
    key("ArrowUp"),
    expect(input).toHaveAttr("aria-activedescendant", searchOptionIdOf(first.node)),
    key("ArrowDown"),
    scrolled,
    expect(input).toHaveAttr("aria-activedescendant", searchOptionIdOf(second.node)),
    expect(optionOf(second.node)).toHaveAttr("aria-selected", "true"),
    expect(optionOf(first.node)).toHaveAttr("aria-selected", "false"),
    expect(elementOf(second.node)).toHaveAttr("data-search", "active"),
    expect(elementOf(first.node)).toHaveAttr("data-search", "match"),
    ...litNodes(secondChain),
    key("ArrowUp"),
    scrolled,
    expect(input).toHaveAttr("aria-activedescendant", searchOptionIdOf(first.node)),
    // A key the input leaves to typing is not handled.
    keydown(input, "a"),
    expectIgnored(),
  );
});

/** A query with a handful of results, so walking the whole list stays quick. */
const FEW = "fuzzy search";
const fewResults = searchTrace(demoTrace, FEW);

it("walking down the list stops at its last result", () => {
  assert(fewResults.length).toBeGreaterThan(2);
  assert(fewResults.length).toBeLessThan(12);
  const last = Option.getOrThrow(Array.last(fewResults));
  const downs = Array.makeBy(fewResults.length, () => [key("ArrowDown"), scrolled] as const);
  scene(
    { update, view },
    given(loaded),
    mounted,
    ...typedFindingResults(FEW),
    ...Array.flatMap(Array.take(downs, fewResults.length - 1), (step) => step),
    expect(input).toHaveAttr("aria-activedescendant", searchOptionIdOf(last.node)),
    key("ArrowDown"),
    expect(input).toHaveAttr("aria-activedescendant", searchOptionIdOf(last.node)),
    expect(optionOf(last.node)).toHaveAttr("aria-selected", "true"),
  );
});

/** The viewport at `zoom` with nothing in it, as the canvas pane's mount reports it. */
const panned = (viewport: Viewport) => Subscription.emit(Message.PannedOrZoomed({ viewport }));

/** Where the middle of a box lands in the pane once the toolbar and a drawer are out of the way. */
const centred = (
  rect: { x: number; y: number; width: number; height: number },
  zoom: number,
  drawer: number,
): Viewport => {
  const left = TOOLBAR_MARGIN + TOOLBAR_WIDTH;
  const middleX = left + (paneSize.width - left - drawer) / 2;
  return {
    x: middleX - (rect.x + rect.width / 2) * zoom,
    y: paneSize.height / 2 - (rect.y + rect.height / 2) * zoom,
    zoom,
  };
};

const rectOf = (positions: Positions, node: Node) =>
  Option.getOrThrow(Record.get(positions, node.id));

const left = Subscription.emit(Message.LeftNode());

it("Enter centres the result at the current zoom without pinning it or opening the drawer", () => {
  const zoom = 1.5;
  scene(
    { update, view },
    given(loaded),
    mountedWith(boxes),
    panned({ x: 30, y: -40, zoom }),
    ...typedFindingResults(QUERY),
    // Typing alone moves nothing: only selecting does.
    expect(canvas).toHaveAttr(VIEWPORT_ATTRIBUTE, viewportAttribute({ x: 30, y: -40, zoom })),
    key("Enter"),
    expect(canvas).toHaveAttr(
      VIEWPORT_ATTRIBUTE,
      viewportAttribute(centred(rectOf(boxes, first.node), zoom, 0)),
    ),
    expectAll(all.role("button", { pressed: true })).toBeEmpty(),
    expect(selector("[data-drawer]")).toBeAbsent(),
    // The input still holds the query and the results stay listed.
    expect(input).toHaveValue(QUERY),
    expectAll(options).toHaveCount(results.length),
  );
});

it("clicking a result selects it as Enter does, and keeps focus in the input", () => {
  const zoom = 0.5;
  scene(
    { update, view },
    given(loaded),
    mountedWith(boxes),
    panned({ x: 0, y: 0, zoom }),
    ...typedFindingResults(QUERY),
    click(optionOf(second.node)),
    refocused,
    expect(input).toHaveAttr("aria-activedescendant", searchOptionIdOf(second.node)),
    expect(canvas).toHaveAttr(
      VIEWPORT_ATTRIBUTE,
      viewportAttribute(centred(rectOf(boxes, second.node), zoom, 0)),
    ),
    expectAll(all.role("button", { pressed: true })).toBeEmpty(),
    expect(selector("[data-drawer]")).toBeAbsent(),
    expect(optionOf(first.node)).toHaveAttr("data-active", "false"),
  );
});

const pointerId = 3;
const dragTo = (id: TaskId, x: number, y: number) => [
  Subscription.emit(
    Message.PressedMoveHandle({
      movable: Movable.Task({ id }),
      pointer: { x: 0, y: 0 },
      pointerId,
    }),
  ),
  Subscription.emit(Message.MovedDragPointer({ buttons: 1, pointer: { x, y }, pointerId })),
  Subscription.emit(Message.ReleasedDragPointer({ pointerId })),
];

const target = Option.getOrThrow(Array.get(searchTrace(demoTrace, "t9"), 0));
const targetId = Schema.decodeSync(TaskId)(target.node.id);
const dragged: Positions = Record.set(boxes, targetId, {
  ...rectOf(boxes, target.node),
  x: rectOf(boxes, target.node).x + 25,
  y: rectOf(boxes, target.node).y - 15,
});
const aSpecSection = Option.getOrThrow(Array.head(demoTrace.spec.sections));

it("centring follows a moved card, the zoom and an open drawer", () => {
  const zoom = 2;
  assert(target.node.id).toBe("t9");
  scene(
    { update, view },
    given(loaded),
    mountedWith(boxes),
    panned({ x: 12, y: 34, zoom }),
    click(sectionButton("Spec", aSpecSection.id)),
    focusedDrawerHeading,
    // At zoom 2 a pointer move of (50, -30) moves the card by (25, -15) canvas units; the layer's
    // mount then measures the card where it ended up.
    ...dragTo(targetId, 50, -30),
    Subscription.emit(Message.MeasuredLayout({ positions: dragged })),
    ...typedFindingResults("t9"),
    key("Enter"),
    expect(canvas).toHaveAttr(
      VIEWPORT_ATTRIBUTE,
      viewportAttribute(centred(rectOf(dragged, target.node), zoom, DRAWER_WIDTH)),
    ),
    // The drawer is still open and nothing but the section is pinned.
    expect(selector("[data-drawer]")).toExist(),
    expectAll(all.role("button", { pressed: true })).toHaveCount(1),
  );
});

it("a result selected before layout is centred by the first measurement that has it", () => {
  const zoom = 0.5;
  const here = { x: 7, y: 8, zoom };
  scene(
    { update, view },
    given(loaded),
    // The pane is measured but no node is.
    mounted,
    panned({ x: 0, y: 0, zoom }),
    ...typedFindingResults("t9"),
    key("Enter"),
    expect(canvas).toHaveAttr(VIEWPORT_ATTRIBUTE, viewportAttribute({ x: 0, y: 0, zoom })),
    Subscription.emit(Message.MeasuredLayout({ positions: boxes })),
    expect(canvas).toHaveAttr(
      VIEWPORT_ATTRIBUTE,
      viewportAttribute(centred(rectOf(boxes, target.node), zoom, 0)),
    ),
    // Once centred, a later measurement and the user's own pan are left alone.
    panned(here),
    Subscription.emit(Message.MeasuredLayout({ positions: dragged })),
    expect(canvas).toHaveAttr(VIEWPORT_ATTRIBUTE, viewportAttribute(here)),
  );
});

it("a result selected before the pane is measured waits for the pane", () => {
  const zoom = 1;
  scene(
    { update, view },
    given(loaded),
    // The pane's mount has reported a viewport but not yet its size.
    Mount.resolve(PanZoomCanvas, Message.PannedOrZoomed({ viewport: { x: 0, y: 0, zoom } })),
    layerMountedWith(boxes),
    ...typedFindingResults("t9"),
    key("Enter"),
    expect(canvas).toHaveAttr(VIEWPORT_ATTRIBUTE, viewportAttribute({ x: 0, y: 0, zoom })),
    Subscription.emit(Message.MeasuredPane({ size: paneSize })),
    expect(canvas).toHaveAttr(
      VIEWPORT_ATTRIBUTE,
      viewportAttribute(centred(rectOf(boxes, target.node), zoom, 0)),
    ),
  );
});

it("a new query drops a centring still waiting for the last one", () => {
  const zoom = 1;
  scene(
    { update, view },
    given(loaded),
    mounted,
    ...typedFindingResults("t9"),
    key("Enter"),
    ...typedFindingResults("t8"),
    Subscription.emit(Message.MeasuredLayout({ positions: boxes })),
    expect(canvas).toHaveAttr(VIEWPORT_ATTRIBUTE, viewportAttribute({ x: 0, y: 0, zoom })),
  );
});

const pinnedFirst = first.node;
const pinnedOther = outsideChain;

it("search, hover and several pins coexist, and hover stays on top", () => {
  assert(isInChain(chainOf(demoTrace, pinnedOther), pinnedFirst)).toBe(false);
  const stripe = `inset 4px 0 0 ${PIN_PALETTE.blue.stroke}`;
  scene(
    { update, view },
    given(loaded),
    mounted,
    click(buttonOf(pinnedFirst)),
    focusedDrawerHeading,
    click(buttonOf(pinnedOther)),
    focusedDrawerHeading,
    ...typedFindingResults(QUERY),
    // The search chain is drawn over the pins' fills; the pin stripe stays.
    expect(elementOf(pinnedFirst)).toHaveStyle("background", SEARCH_FILL),
    expect(elementOf(pinnedFirst)).toHaveStyle("box-shadow", stripe),
    expect(elementOf(pinnedFirst)).toHaveAttr("data-pins", "blue"),
    // A pinned chain outside the search chain keeps its own fill.
    expect(elementOf(pinnedOther)).toHaveAttr("data-pins", "rose"),
    expect(elementOf(pinnedOther)).toHaveStyle("background", PIN_PALETTE.rose.fill),
    // Hovering previews above both, and leaving gives the search back.
    hover(elementOf(pinnedFirst)),
    expect(elementOf(pinnedFirst)).toHaveStyle("background", HOVER_FILL),
    expect(elementOf(pinnedFirst)).toHaveStyle("box-shadow", stripe),
    left,
    expect(elementOf(pinnedFirst)).toHaveStyle("background", SEARCH_FILL),
    expectAll(all.role("button", { pressed: true })).toHaveCount(2),
  );
});

it("Escape and an emptied query clear the search but keep pins, the drawer and the viewport", () => {
  const zoom = 1.25;
  const cleared = Array.flatten([
    [
      expect(input).toHaveValue(""),
      expect(status).toHaveText(""),
      expect(input).toHaveAttr("aria-expanded", "false"),
      expectAll(options).toBeEmpty(),
      expectAll(all.selector("[data-search]")).toBeEmpty(),
      expectAll(all.selector("[data-search-chain]")).toBeEmpty(),
      expectAll(all.selector("mark")).toBeEmpty(),
    ],
    // Only the pin's own chain is still lit.
    litNodes(chainOf(demoTrace, pinnedOther)),
    [
      expect(elementOf(pinnedOther)).toHaveAttr("data-pins", "blue"),
      expectAll(all.role("button", { pressed: true })).toHaveCount(1),
      expect(selector("[data-drawer]")).toExist(),
    ],
  ]);
  scene(
    { update, view },
    given(loaded),
    mountedWith(boxes),
    panned({ x: 3, y: 4, zoom }),
    click(buttonOf(pinnedOther)),
    focusedDrawerHeading,
    ...typedFindingResults(QUERY),
    key("Enter"),
    key("Escape"),
    ...cleared,
    // Clearing leaves the canvas where selecting put it.
    expect(canvas).toHaveAttr(
      VIEWPORT_ATTRIBUTE,
      viewportAttribute(centred(rectOf(boxes, first.node), zoom, DRAWER_WIDTH)),
    ),
    ...typedFindingResults(QUERY),
    expectAll(options).toHaveCount(results.length),
    typed(""),
    ...cleared,
  );
});

it("a query with no matches says so and leaves the canvas usable", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    typed("zzzzqqqq"),
    expect(status).toHaveText('No results for "zzzzqqqq"'),
    expect(input).toHaveAttr("aria-expanded", "false"),
    expectAll(options).toBeEmpty(),
    expectAll(all.selector("[data-dimmed]")).toBeEmpty(),
    expectAll(all.selector("[data-highlighted]")).toBeEmpty(),
    expectAll(all.selector("[data-search]")).toBeEmpty(),
    key("ArrowDown"),
    key("Enter"),
    click(sectionButton("Spec", aSpecSection.id)),
    focusedDrawerHeading,
    expect(selector("[data-drawer]")).toExist(),
    expectAll(all.role("button", { pressed: true })).toHaveCount(1),
    // A blank query is no query: nothing is announced.
    typed("   "),
    expect(status).toHaveText(""),
  );
});

/** The trace without one task. */
const without = (id: string) =>
  Struct.evolve(demoTrace, { tasks: (tasks) => Array.filter(tasks, (task) => task.id !== id) });

const run = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
  Array.reduce(messages, model, (current, message) => update(current, message).model);

const refreshedWith = (trace: typeof demoTrace) =>
  Message.SettledLoadTrace({ result: Result.succeed(trace) });

const removable = Option.getOrThrow(
  Array.findFirst(
    Array.drop(results, 1),
    (result) => result.node.kind === "task" && result.node.id !== first.node.id,
  ),
);

it("a refresh keeps the active result while it still matches, and picks the first when it is gone", () => {
  const searched = run(loaded, Message.EditedSearchQuery({ query: QUERY }));
  const kept = run(
    searched,
    Message.ClickedSearchResult({ node: second.node }),
    refreshedWith(Struct.evolve(demoTrace, { sections: () => [] })),
  );
  assert(kept.search.maybeActive).toEqual(Option.some(second.node));
  assert(kept.search.results).toEqual(results);

  const trimmed = without(removable.node.id);
  const reconciled = run(
    searched,
    Message.ClickedSearchResult({ node: removable.node }),
    refreshedWith(trimmed),
  );
  const expected = searchTrace(trimmed, QUERY);
  assert(reconciled.search.results).toEqual(expected);
  assert(
    Array.some(reconciled.search.results, (result) => result.node.id === removable.node.id),
  ).toBe(false);
  assert(reconciled.search.maybeActive).toEqual(
    Option.map(Array.head(expected), (result) => result.node),
  );
  assert(reconciled.maybeCentring).toEqual(Option.none());
  // The refresh is a plain trace change: everything but the search is as it was.
  assert(reconciled.pins).toEqual(searched.pins);
});

it("a refresh that matches nothing leaves no active result, and a trace that fails keeps the results", () => {
  const searched = run(loaded, Message.EditedSearchQuery({ query: "t9" }));
  assert(searched.search.maybeActive).toEqual(Option.some(target.node));
  const emptied = run(searched, refreshedWith(without("t9")));
  assert(Array.some(emptied.search.results, (result) => result.node.id === "t9")).toBe(false);
  const failed = run(searched, Message.SettledLoadTrace({ result: Result.fail("offline") }));
  assert(failed.search).toEqual(searched.search);
});

const ScrollArgs = Schema.Struct({ node: Node });

/** The nodes the scroll commands among these commands scroll to. */
const scrollTargets = (
  commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined,
) =>
  Array.getSomes(
    Array.map(commands ?? [], (command) =>
      command.name === ScrollSearchResult.name
        ? Option.map(Schema.decodeUnknownOption(ScrollArgs)(command.args), ({ node }) => node)
        : Option.none(),
    ),
  );

it("a new query or a refresh that moves the active result scrolls the list to it", () => {
  const searched = run(loaded, Message.EditedSearchQuery({ query: QUERY }));
  // Walking down the list leaves it scrolled; a new query starts on a new first result.
  const walked = run(searched, Message.ClickedSearchResult({ node: removable.node }));
  const edited = update(walked, Message.EditedSearchQuery({ query: "t9" }));
  assert(scrollTargets(edited.commands)).toEqual([target.node]);
  // A query that matches nothing has no result to scroll to.
  assert(update(walked, Message.EditedSearchQuery({ query: "zzzzqqqq" })).commands ?? []).toEqual(
    [],
  );
  // The active result was removed, so the first of the rest is scrolled to.
  const trimmed = without(removable.node.id);
  const refreshed = update(walked, refreshedWith(trimmed));
  const newFirst = Option.getOrThrow(Array.head(searchTrace(trimmed, QUERY)));
  assert(scrollTargets(refreshed.commands)).toEqual([newFirst.node]);
  // A refresh that keeps the active result leaves the scroll alone.
  assert(
    scrollTargets(
      update(walked, refreshedWith(Struct.evolve(demoTrace, { sections: () => [] }))).commands,
    ),
  ).toEqual([]);
});

it("a removed result leaves no mark, outline or chain on the canvas", () => {
  const trimmed = without(removable.node.id);
  const expected = searchTrace(trimmed, QUERY);
  scene(
    { update, view },
    given(loaded),
    mounted,
    ...typedFindingResults(QUERY),
    click(optionOf(removable.node)),
    refocused,
    expect(elementOf(removable.node)).toHaveAttr("data-search", "active"),
    Subscription.emit(refreshedWith(trimmed)),
    scrolled,
    expect(elementOf(removable.node)).toBeAbsent(),
    expect(optionOf(removable.node)).toBeAbsent(),
    expectAll(options).toHaveCount(expected.length),
    expectAll(all.selector('[data-search="active"]')).toHaveCount(1),
    expectAll(all.selector('[data-search="match"]')).toHaveCount(expected.length - 1),
    expect(status).toHaveText(`${expected.length} results`),
  );
});

const curves = curvesOf(demoTrace, boxes, columnOf(stackLayoutOf(demoTrace.tasks)));
const insideBoth = (a: typeof firstChain, b: typeof firstChain) =>
  Array.filter(
    curves,
    (curve) =>
      (isInChain(a, curve.source) && isInChain(a, curve.target)) ||
      (isInChain(b, curve.source) && isInChain(b, curve.target)),
  );

it("a curve is lit only when both of its ends are in the same chain", () => {
  const pinChain = chainOf(demoTrace, pinnedOther);
  const lit = insideBoth(firstChain, pinChain);
  const bridging = Array.filter(
    curves,
    (curve) =>
      !Array.some(lit, (each) => each.id === curve.id) &&
      ((isInChain(firstChain, curve.source) && isInChain(pinChain, curve.target)) ||
        (isInChain(pinChain, curve.source) && isInChain(firstChain, curve.target))),
  );
  scene(
    { update, view },
    given(loaded),
    mountedWith(boxes),
    expect(selector("[data-edge]")).toBeAbsent(),
    ...typedFindingResults(QUERY),
    expectAll(all.selector("[data-edge]")).toHaveCount(insideBoth(firstChain, firstChain).length),
    ...Array.map(insideBoth(firstChain, firstChain), (curve) =>
      expect(selector(`[data-edge="${curve.id}"]`)).toHaveAttr("data-search-chain", "true"),
    ),
    click(buttonOf(pinnedOther)),
    focusedDrawerHeading,
    expectAll(all.selector("[data-edge]")).toHaveCount(lit.length),
    // No curve between the search chain and the pin's is drawn on its own.
    ...Array.map(bridging, (curve) => expect(selector(`[data-edge="${curve.id}"]`)).toBeAbsent()),
    key("Escape"),
    expectAll(all.selector("[data-edge]")).toHaveCount(
      insideBoth(chainOf(demoTrace, pinnedOther), chainOf(demoTrace, pinnedOther)).length,
    ),
    expectAll(all.selector("[data-search-chain]")).toBeEmpty(),
  );
});

const Coordinate = Schema.Finite.check(Schema.isBetween({ maximum: 5000, minimum: -5000 }));
const Extent = Schema.Finite.check(Schema.isBetween({ maximum: 3000, minimum: 0 }));

const Centring = Schema.Struct({
  isDrawerOpen: Schema.Boolean,
  pane: Schema.Struct({ height: Extent, width: Extent }),
  rect: Schema.Struct({ height: Extent, width: Extent, x: Coordinate, y: Coordinate }),
  viewport: Schema.Struct({
    x: Coordinate,
    y: Coordinate,
    zoom: Schema.Finite.check(Schema.isBetween({ maximum: MAX_ZOOM, minimum: MIN_ZOOM })),
  }),
});

/** A model that has searched for the target, so each sample only has to select it. */
const searchedForTarget = run(loaded, Message.EditedSearchQuery({ query: "t9" }));

it.prop(
  "a selected result lands in the middle of the clear part of the pane",
  { centring: Centring },
  ({ centring }) => {
    const { isDrawerOpen, pane, rect, viewport } = centring;
    const model = run(
      modifyFields(searchedForTarget, {
        drawer: () =>
          isDrawerOpen
            ? Drawer.Open({ maybeCommitSha: Option.none(), node: first.node })
            : Drawer.Closed(),
        maybePaneSize: () => Option.some(pane),
        positions: () => Record.set(boxes, target.node.id, rect),
        viewport: () => viewport,
      }),
      Message.PressedSearchEnter(),
    );
    const covered = TOOLBAR_MARGIN + TOOLBAR_WIDTH;
    const clear = pane.width - covered - (isDrawerOpen ? DRAWER_WIDTH : 0);
    const middle = toScreen(
      { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      model.viewport,
    );
    assert(model.viewport.zoom).toBe(viewport.zoom);
    assert(middle.x).toBeCloseTo(clear > 0 ? covered + clear / 2 : pane.width / 2, 6);
    assert(middle.y).toBeCloseTo(pane.height / 2, 6);
    assert(model.maybeCentring).toEqual(Option.none());
    assert(model.pins).toEqual([]);
  },
);

it.prop(
  "only an unmodified arrow, Enter or Escape is a search key",
  {
    alt: Schema.Boolean,
    ctrl: Schema.Boolean,
    key: Schema.Literals([
      "ArrowDown",
      "ArrowUp",
      "Enter",
      "Escape",
      "a",
      "Tab",
      "Home",
      " ",
      "ArrowLeft",
    ]),
    meta: Schema.Boolean,
    shift: Schema.Boolean,
  },
  ({ alt, ctrl, key: pressed, meta, shift }) => {
    const handled = searchKeyMessageOf(pressed, {
      altKey: alt,
      ctrlKey: ctrl,
      metaKey: meta,
      shiftKey: shift,
    });
    const isSearchKey = Array.contains(["ArrowDown", "ArrowUp", "Enter", "Escape"], pressed);
    assert(Option.isSome(handled)).toBe(isSearchKey && !alt && !ctrl && !meta && !shift);
  },
);

// Lazy boundaries.

const sequence = (models: ReadonlyArray<Model>) => {
  let render = 0;
  return (_model: Model, h: HtmlBuilder<Message>): Document => {
    const model = Option.getOrThrow(Array.get(models, render % models.length));
    render += 1;
    return view(model, h);
  };
};

const searching = run(loaded, Message.EditedSearchQuery({ query: QUERY }));
const panFrame = (x: number) =>
  modifyFields(searching, { viewport: () => ({ x, y: x, zoom: 1 + x }) });

it("a pan or a measurement with a search active reuses the columns", () => {
  assert(() =>
    Lazy.expectAllReused({ model: searching, view: sequence([panFrame(0), panFrame(1)]) }),
  ).not.toThrow();
  assert(() =>
    Lazy.expectAllReused({
      model: searching,
      view: sequence([searching, run(searching, Message.MeasuredLayout({ positions: boxes }))]),
    }),
  ).not.toThrow();
});

it("a new query or a new active result rebuilds the columns, but no document is parsed again", () => {
  assert(() =>
    Lazy.expectAllReused({
      model: searching,
      view: sequence([searching, run(searching, Message.EditedSearchQuery({ query: "redact" }))]),
    }),
  ).toThrow("ArgumentsChanged");
  assert(() =>
    Lazy.expectAllReused({
      model: searching,
      view: sequence([searching, run(searching, Message.PressedSearchArrowDown())]),
    }),
  ).toThrow("ArgumentsChanged");
  // The rebuilt columns read the syntax trees the first render kept.
  assert(treeOf(demoTrace.prd.markdown)).toBe(treeOf(demoTrace.prd.markdown));
  assert(treeOf(demoTrace.spec.markdown)).toBe(treeOf(demoTrace.spec.markdown));
  assert(treeOf(demoTrace.spec.markdown)).not.toBe(treeOf(demoTrace.prd.markdown));
});

// Prose.

const PROBE_ID = Schema.decodeSync(SectionId)("prd.search-probe");
const probeNode: Node = { id: PROBE_ID, kind: "section" };
const probeMarkdown = `${demoTrace.prd.markdown}

## Search probe {#prd.search-probe}

Some **bold phrase** with [a link](https://example.com/probe) inside a probe paragraph.
`;
const probeTrace: Trace = {
  ...demoTrace,
  prd: {
    ...demoTrace.prd,
    markdown: probeMarkdown,
    sections: Array.append(demoTrace.prd.sections, {
      human: false,
      id: PROBE_ID,
      keys: { context: [], defers: [], dependsOn: [], files: [], implements: [] },
      level: 2,
      line: 1,
      parent: null,
      title: "Search probe",
    }),
  },
};
const probeModel = modifyFields(loaded, { trace: () => TraceData.Success({ data: probeTrace }) });
const PROSE_QUERY = "bold phrase with a link";
const probeResult = Option.getOrThrow(Array.get(searchTrace(probeTrace, PROSE_QUERY), 0));
const probeBlock = Option.getOrThrow(probeResult.maybeBlock);
const probeParagraph = selector(`[data-block="${probeBlock}"]`);
const probeBoxes: Positions = Record.set(boxes, PROBE_ID, {
  height: 20,
  width: 100,
  x: 910,
  y: 700,
});
/** Where the probe paragraph sits once measured, far from its section. */
const probeRect = { height: 40, width: 300, x: 1500, y: 2400 };

it("finds prose across bold text and a link, marks the snippet and the paragraph, and keeps the formatting", () => {
  assert(documentOf(probeMarkdown).byStart).toBeDefined();
  assert(probeResult.node).toEqual(probeNode);
  assert(probeResult.field).toBe("prose");
  scene(
    { update, view },
    given(probeModel),
    mountedWith(probeBoxes),
    ...typedFindingResults(PROSE_QUERY),
    // The result names its kind and section, and shows the matched prose with the match marked.
    expect(optionOf(probeNode)).toContainText("PRD"),
    expect(optionOf(probeNode)).toContainText("Search probe"),
    expect(within(optionOf(probeNode), selector("[data-matched-field]"))).toContainText("prose"),
    expect(within(optionOf(probeNode), selector("mark"))).toHaveText(PROSE_QUERY),
    // The paragraph marks the same text, split across the bold text, the text between and the link.
    expectAll(all.selector(`[data-block="${probeBlock}"] mark`)).toHaveCount(3),
    expect(within(probeParagraph, selector("strong mark"))).toHaveText("bold phrase"),
    expect(within(probeParagraph, selector("a mark"))).toHaveText("a link"),
    expect(within(probeParagraph, selector("a"))).toHaveAttr("href", "https://example.com/probe"),
    expect(within(probeParagraph, selector("a"))).toHaveText("a link"),
    expect(probeParagraph).toHaveText("Some bold phrase with a link inside a probe paragraph."),
    // The section is the active result, outlined, and its heading is not marked.
    expect(elementOf(probeNode)).toHaveAttr("data-search", "active"),
    expect(within(elementOf(probeNode), selector("mark"))).toBeAbsent(),
  );
});

it("selecting a prose result centres its section at once and then its measured paragraph", () => {
  const zoom = 0.75;
  scene(
    { update, view },
    given(probeModel),
    mountedWith(probeBoxes),
    panned({ x: 0, y: 0, zoom }),
    ...typedFindingResults(PROSE_QUERY),
    key("Enter"),
    expect(canvas).toHaveAttr(
      VIEWPORT_ATTRIBUTE,
      viewportAttribute(centred(rectOf(probeBoxes, probeNode), zoom, 0)),
    ),
    Command.resolve(
      MeasureSearchBlock,
      Message.MeasuredSearchBlock({ block: probeBlock, maybeRect: Option.some(probeRect) }),
    ),
    expect(canvas).toHaveAttr(VIEWPORT_ATTRIBUTE, viewportAttribute(centred(probeRect, zoom, 0))),
    expectAll(all.role("button", { pressed: true })).toBeEmpty(),
    expect(selector("[data-drawer]")).toBeAbsent(),
  );
});

it("clearing a prose search removes its marks but not the formatting, the pins or the drawer", () => {
  scene(
    { update, view },
    given(probeModel),
    mountedWith(probeBoxes),
    click(buttonOf(pinnedOther)),
    focusedDrawerHeading,
    ...typedFindingResults(PROSE_QUERY),
    key("Enter"),
    Command.resolve(
      MeasureSearchBlock,
      Message.MeasuredSearchBlock({ block: probeBlock, maybeRect: Option.some(probeRect) }),
    ),
    expectAll(all.selector("mark")).not.toBeEmpty(),
    key("Escape"),
    expectAll(all.selector("mark")).toBeEmpty(),
    expect(within(probeParagraph, selector("strong"))).toHaveText("bold phrase"),
    expect(within(probeParagraph, selector("a"))).toHaveAttr("href", "https://example.com/probe"),
    expect(probeParagraph).toHaveText("Some bold phrase with a link inside a probe paragraph."),
    expect(elementOf(pinnedOther)).toHaveAttr("data-pins", "blue"),
    expectAll(all.role("button", { pressed: true })).toHaveCount(1),
    expect(selector("[data-drawer]")).toExist(),
  );
});

it("a heading matched by its title keeps its inline formatting and marks the matched text", () => {
  const formatted: Node = {
    id: Schema.decodeSync(SectionId)("spec.sections.cairn-ids"),
    kind: "section",
  };
  const [top] = searchTrace(demoTrace, "cairn ids");
  assert(top?.field).toBe("title");
  assert(top?.node).toEqual(formatted);
  scene(
    { update, view },
    given(loaded),
    mounted,
    ...typedFindingResults("cairn ids"),
    expect(within(elementOf(formatted), selector("code"))).toHaveText("cairn ids"),
    expect(within(elementOf(formatted), selector("code mark"))).toHaveText("cairn ids"),
    expect(elementOf(formatted)).toHaveAttr("data-search", "active"),
    // The node button still has its name, so the heading is still a button for the keyboard.
    expect(within(elementOf(formatted), role("button", { name: "cairn ids" }))).toExist(),
  );
});

it("a measured paragraph that is not the active result's, or not found, moves nothing", () => {
  const selected = run(
    modifyFields(probeModel, { maybePaneSize: () => Option.some(paneSize) }),
    Message.MeasuredLayout({ positions: probeBoxes }),
    Message.EditedSearchQuery({ query: PROSE_QUERY }),
    Message.PressedSearchEnter(),
  );
  const measured = (block: string, maybeRect: Option.Option<typeof probeRect>) =>
    run(selected, Message.MeasuredSearchBlock({ block, maybeRect })).viewport;
  assert(measured("prd.other@1", Option.some(probeRect))).toEqual(selected.viewport);
  assert(measured(probeBlock, Option.none())).toEqual(selected.viewport);
  assert(measured(probeBlock, Option.some(probeRect))).not.toEqual(selected.viewport);
  // Only a prose result asks for its paragraph to be measured; a title or a task does not.
  assert(
    update(
      run(probeModel, Message.EditedSearchQuery({ query: "t9" })),
      Message.PressedSearchEnter(),
    ).commands,
  ).toEqual([]);
  assert(
    update(
      run(probeModel, Message.EditedSearchQuery({ query: PROSE_QUERY })),
      Message.PressedSearchEnter(),
    ).commands,
  ).toHaveLength(1);
});
