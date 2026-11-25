import { PrdSectionId, SectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, HashSet, Option, Record, Schema, String } from "effect";
import {
  Command,
  Mount,
  Subscription,
  all,
  click,
  expect,
  expectAll,
  expectHandled,
  given,
  hover,
  keydown,
  role,
  scene,
  selector,
} from "foldkit/scene";
import * as simulate from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { cardsOf, isCardless, searchedSectionOf, targetsOf } from "../src/reader.ts";
import { NO_SEARCH, queried, searchTrace, type SearchResult } from "../src/search.ts";
import { chainOf, nodeKeyOf, type Node } from "../src/trace.ts";
import { ScrollSearchTargets, update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { view } from "../src/view/view.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { linksOf, type Measured, type Panes } from "../src/wires.ts";
import { focusedSearchInput, loaded, scrolledSearchResult } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });

const prd = (id: string) => PrdSectionId.make(id);
const sectionNode = (id: string): Node => ({
  id: Schema.decodeSync(SectionId)(id),
  kind: "section",
});
const taskNode = (id: string): Node => ({ id: TaskId.make(id), kind: "task" });

const searchBox = role("combobox", { name: "Search sections and tasks" });
const status = selector("[data-search-status]");
const typed = (query: string) => simulate.type(searchBox, query);
const pressed = (key: string) => keydown(searchBox, key);
const option = (node: Node) => selector('[data-search-result="' + nodeKeyOf(node) + '"]');

const heading = (id: string) => selector('[data-prd-pane] [data-section="' + id + '"]');
const statusLine = (id: string) => selector('[data-status-line="' + id + '"]');
const card = (id: string) => selector('[data-spec="' + id + '"]');
const row = (id: string) => selector('[data-task-row="spec.planning.stack-order:' + id + '"]');
const chip = (id: string) => selector('[data-stacks-pane] [data-task="' + id + '"]');
const panel = selector("[data-detail]");
const mark = selector("[data-search-match]");
const marks = all.selector("[data-search-match]");
const searched = all.selector("[data-searched]");

const PINNED = "prd.viewer.reader";

/** The mounts the reader starts, answered as a page with this measurement would. */
const mounted = (measured: Measured) =>
  Mount.resolveAll(
    [TrackPrdScroll, Message.ScrolledPrd({ id: prd("prd.goal") })],
    [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
    [MeasureWires, Message.MeasuredWires({ measured })],
  );

const noPanes: Panes = {
  prd: { height: 0, width: 0, x: 0, y: 0 },
  spec: { height: 0, width: 0, x: 0, y: 0 },
  stacks: { height: 0, width: 0, x: 0, y: 0 },
};
const unmeasured: Measured = { boxes: {}, panes: noPanes };

/** Three panes, tall enough that every box below is in view. */
const panes: Panes = {
  prd: { height: 4000, width: 500, x: 0, y: 50 },
  spec: { height: 4000, width: 400, x: 500, y: 50 },
  stacks: { height: 4000, width: 300, x: 900, y: 50 },
};

const paneOf = (key: string) =>
  String.startsWith("prd:")(key)
    ? panes.prd
    : String.startsWith("task:")(key)
      ? panes.stacks
      : panes.spec;

/** Every wire end of a section's cards, boxed in its own pane, one below the other. */
const measuredFor = (id: string): Measured => {
  const links = linksOf(prd(id), cardsOf(demoTrace, prd(id)));
  const keys = Array.dedupe(Array.flatMap(links, (link) => [link.source, link.target]));
  return {
    boxes: Record.fromEntries(
      Array.map(keys, (key, index) => {
        const pane = paneOf(key);
        return [
          key,
          { height: 24, width: 120, x: pane.x + 10, y: pane.y + 40 + index * 40 },
        ] as const;
      }),
    ),
    panes,
  };
};

const MANIFEST = "prd.manifest-schema";
const STACK_ORDER = sectionNode("spec.planning.stack-order");
const wireLayer = "[data-wire-layer]";
const lit = all.selector(wireLayer + " path[data-lit]");
const faint = all.selector(wireLayer + " path[data-dimmed]");
const wireCount = Array.length(linksOf(prd(MANIFEST), cardsOf(demoTrace, prd(MANIFEST))));
const stackOrderTasks = Array.length(
  Array.filter(demoTrace.tasks, (task) =>
    Array.some(task.specSections, (id) => String.Equivalence(id, STACK_ORDER.id)),
  ),
);

const left = Subscription.emit(Message.LeftNode());

const scrolled = (
  ...targets: ReadonlyArray<{ block: "nearest" | "start"; selectors: ReadonlyArray<string> }>
) => Command.resolve(ScrollSearchTargets({ targets }), Message.CompletedScrollSearchTargets());

it("selecting a PRD section scrolls the PRD to its heading and makes it current, keeping the pin", () => {
  scene(
    { update, view },
    given(reading),
    mounted(unmeasured),
    click(statusLine(PINNED)),
    expect(heading(PINNED)).toHaveAttr("data-current", ""),
    typed("fuzzy search"),
    scrolledSearchResult,
    expect(status).toHaveText(Array.length(searchTrace(demoTrace, "fuzzy search")) + " results."),
    // The active result is current ahead of the pin, outlined and marked in its heading.
    expect(heading("prd.viewer.fuzzy-search")).toHaveAttr("data-searched", "active"),
    expect(heading("prd.viewer.fuzzy-search")).toHaveAttr("data-current", ""),
    expect(heading(PINNED)).not.toHaveAttr("data-current"),
    expect(simulate.within(heading("prd.viewer.fuzzy-search"), mark)).toExist(),
    expect(statusLine(PINNED)).toHaveAttr("aria-pressed", "true"),
    // Nothing is scrolled until a result is selected.
    pressed("Enter"),
    expectHandled(),
    scrolled({
      block: "start",
      selectors: ['[data-prd-pane] [data-section="prd.viewer.fuzzy-search"]'],
    }),
    // Escape clears the search and its marks; the pin is current again and is still pinned.
    pressed("Escape"),
    expectHandled(),
    expectAll(searched).toBeEmpty(),
    expectAll(marks).toBeEmpty(),
    expect(heading(PINNED)).toHaveAttr("data-current", ""),
    expect(statusLine(PINNED)).toHaveAttr("aria-pressed", "true"),
  );
});

it("a spec section makes its first PRD section current, lights only its own curves and scrolls its card", () => {
  const litWires = 1 + stackOrderTasks;
  scene(
    { update, view },
    given(reading),
    mounted(measuredFor(MANIFEST)),
    click(statusLine(PINNED)),
    typed("stkorder"),
    scrolledSearchResult,
    // The chain's first PRD section in document order, not the pin; the pin is untouched.
    expect(heading(MANIFEST)).toHaveAttr("data-current", ""),
    expect(heading(PINNED)).not.toHaveAttr("data-current"),
    expect(statusLine(PINNED)).toHaveAttr("aria-pressed", "true"),
    expect(card(STACK_ORDER.id)).toHaveAttr("data-searched", "active"),
    expect(simulate.within(card(STACK_ORDER.id), mark)).toExist(),
    expect(chip("t20")).toHaveAttr("data-searched", "match"),
    // Only the active result's chain is previewed: its curves are lit, every other is faint.
    expectAll(lit).toHaveCount(litWires),
    expectAll(faint).toHaveCount(wireCount - litWires),
    expect(chip("t9")).toHaveAttr("data-dimmed", ""),
    expect(chip("t20")).not.toHaveAttr("data-dimmed"),
    pressed("Enter"),
    expectHandled(),
    scrolled({ block: "nearest", selectors: ['[data-spec="spec.planning.stack-order"]'] }),
    // Hovering is the top preview, and leaving it falls back to the search.
    hover(chip("t9")),
    expect(chip("t20")).toHaveAttr("data-dimmed", ""),
    left,
    expect(chip("t20")).not.toHaveAttr("data-dimmed"),
    expectAll(lit).toHaveCount(litWires),
    pressed("Escape"),
    expectAll(all.selector("[data-dimmed]")).toBeEmpty(),
    expectAll(lit).toBeEmpty(),
    expect(heading(PINNED)).toHaveAttr("data-current", ""),
  );
});

it("a task scrolls its row and its chip, and its chain is the one previewed", () => {
  scene(
    { update, view },
    given(reading),
    mounted(measuredFor(MANIFEST)),
    typed("stkorder"),
    scrolledSearchResult,
    pressed("ArrowDown"),
    scrolledSearchResult,
    expect(heading(MANIFEST)).toHaveAttr("data-current", ""),
    expect(row("t20")).toHaveAttr("data-searched", "active"),
    expect(chip("t20")).toHaveAttr("data-searched", "active"),
    expect(card(STACK_ORDER.id)).toHaveAttr("data-searched", "match"),
    expectAll(lit).toHaveCount(2),
    expect(chip("t9")).toHaveAttr("data-dimmed", ""),
    pressed("Enter"),
    expectHandled(),
    scrolled(
      { block: "nearest", selectors: ['[data-task-row$=":t20"]'] },
      { block: "nearest", selectors: ['[data-stacks-pane] [data-task="t20"]'] },
    ),
  );
});

it("a spec section that implements no PRD section opens in the detail panel, and clearing keeps it open", () => {
  scene(
    { update, view },
    given(reading),
    mounted(unmeasured),
    click(statusLine(PINNED)),
    typed("format"),
    scrolledSearchResult,
    // Moving to it only previews: it has no card, so the pin stays current and nothing opens.
    expect(heading(PINNED)).toHaveAttr("data-current", ""),
    expect(panel).toBeAbsent(),
    pressed("Enter"),
    expectHandled(),
    expect(panel).toHaveAttr("data-detail-id", "spec.format"),
    expect(heading(PINNED)).toHaveAttr("data-current", ""),
    pressed("Escape"),
    expectHandled(),
    expect(searchBox).toHaveValue(""),
    expect(panel).toHaveAttr("data-detail-id", "spec.format"),
    expect(statusLine(PINNED)).toHaveAttr("aria-pressed", "true"),
  );
});

it("a click on a result selects it and returns focus to search, and a task result does not open the panel", () => {
  scene(
    { update, view },
    given(reading),
    mounted(unmeasured),
    typed("stkorder"),
    scrolledSearchResult,
    click(option(taskNode("t20"))),
    scrolled(
      { block: "nearest", selectors: ['[data-task-row$=":t20"]'] },
      { block: "nearest", selectors: ['[data-stacks-pane] [data-task="t20"]'] },
    ),
    focusedSearchInput,
    expect(option(taskNode("t20"))).toHaveAttr("aria-selected", "true"),
    expect(row("t20")).toHaveAttr("data-searched", "active"),
    expect(panel).toBeAbsent(),
    expectAll(all.selector("[data-pins]")).toBeEmpty(),
  );
});

/** The first result of the query that is prose in a section of the document. */
const proseOf = (query: string, isWanted: (result: SearchResult) => boolean): SearchResult =>
  Option.getOrThrow(
    Array.findFirst(
      searchTrace(demoTrace, query),
      (result) => result.field === "prose" && isWanted(result),
    ),
  );

const isSpec = (result: SearchResult) =>
  result.node.kind === "section" &&
  String.startsWith("spec.")(result.node.id) &&
  !isCardless(demoTrace, result.node);
const isPrd = (result: SearchResult) =>
  result.node.kind === "section" && String.startsWith("prd.")(result.node.id);

it("selecting prose in the PRD scrolls to the matched block, falling back to its heading", () => {
  const found = proseOf("trailer", isPrd);
  const offset = Option.getOrThrow(found.maybeOffset);
  scene(
    { update, view },
    given(reading),
    mounted(unmeasured),
    typed("trailer"),
    scrolledSearchResult,
    click(option(found.node)),
    scrolled({
      block: "nearest",
      selectors: [
        '[data-block="prd:' + offset + '"]',
        '[data-prd-pane] [data-section="' + found.node.id + '"]',
      ],
    }),
    focusedSearchInput,
    expect(simulate.within(selector('[data-block="prd:' + offset + '"]'), mark)).toExist(),
    expect(heading(found.node.id)).toHaveAttr("data-searched", "active"),
  );
});

it("a card holding the active result's prose is open while it is active, whatever the density", () => {
  const found = proseOf("judgment", isSpec);
  const section = Option.getOrThrow(searchedSectionOf(demoTrace, Option.some(found.node)));
  const offset = Option.getOrThrow(found.maybeOffset);
  const searching = modifyFields(reading, {
    reader: (reader) =>
      modifyFields(reader, { density: () => "titles", maybePinned: () => Option.some(section) }),
    search: () => queried(NO_SEARCH, Option.some(demoTrace), "judgment"),
  });
  const header = selector('[data-spec="' + found.node.id + '"] [aria-expanded]');
  const full = selector('[data-full-spec="' + found.node.id + '"]');
  scene(
    { update, view },
    // The query has results, none of them active: the card is closed.
    given(
      modifyFields(searching, {
        search: (search) => modifyFields(search, { maybeActive: () => Option.none() }),
      }),
    ),
    mounted(unmeasured),
    expect(header).toHaveAttr("aria-expanded", "false"),
    expect(full).toBeAbsent(),
  );
  scene(
    { update, view },
    given(
      modifyFields(searching, {
        search: (search) => modifyFields(search, { maybeActive: () => Option.some(found.node) }),
      }),
    ),
    mounted(unmeasured),
    expect(header).toHaveAttr("aria-expanded", "true"),
    expect(card(found.node.id)).toHaveAttr("data-searched", "active"),
    expect(simulate.within(full, selector('[data-block="spec:' + offset + '"]'))).toExist(),
    expect(simulate.within(full, mark)).toExist(),
  );
});

it("a query with no match says so and leaves the panes usable and undimmed", () => {
  scene(
    { update, view },
    given(reading),
    mounted(unmeasured),
    click(statusLine(PINNED)),
    typed("zzzzqqqq"),
    expect(status).toHaveText("No results."),
    expect(heading(PINNED)).toHaveAttr("data-current", ""),
    expectAll(all.selector("[data-dimmed]")).toBeEmpty(),
    expectAll(searched).toBeEmpty(),
    pressed("Enter"),
    expectHandled(),
    click(statusLine(PINNED)),
    expect(statusLine(PINNED)).toHaveAttr("aria-pressed", "false"),
  );
});

const sectionIds = Array.map(demoTrace.prd.sections, (section) => section.id);
const specIds = Array.map(demoTrace.spec.sections, (section) => section.id);
const taskIds = Array.map(demoTrace.tasks, (task) => task.id);

it.prop(
  "a node's current section is the first PRD section of its chain, in document order",
  { id: Schema.Literals(specIds) },
  ({ id }) => {
    const node = sectionNode(id);
    const chain = chainOf(demoTrace, node);
    const expected = Array.findFirst(
      demoTrace.prd.sections,
      (section) => section.level > 1 && HashSet.has(chain.prd, section.id),
    );
    assert(searchedSectionOf(demoTrace, Option.some(node))).toStrictEqual(
      Option.map(expected, (section) => prd(section.id)),
    );
    assert(isCardless(demoTrace, node)).toBe(Option.isNone(expected));
  },
);

it.prop(
  "a task's current section is in its chain, and no earlier PRD section is",
  { id: Schema.Literals(taskIds) },
  ({ id }) => {
    const node = taskNode(id);
    const chain = chainOf(demoTrace, node);
    const found = searchedSectionOf(demoTrace, Option.some(node));
    const section = Option.getOrThrow(found);
    assert(HashSet.has(chain.prd, section)).toBe(true);
    const before = Array.takeWhile(
      demoTrace.prd.sections,
      (each) => !String.Equivalence(each.id, section),
    );
    assert(Array.some(before, (each) => each.level > 1 && HashSet.has(chain.prd, each.id))).toBe(
      false,
    );
    assert(isCardless(demoTrace, node)).toBe(false);
  },
);

it.prop(
  "a PRD section is its own current section, except the document's title, which is none",
  { id: Schema.Literals(sectionIds) },
  ({ id }) => {
    const level = Option.getOrThrow(
      Array.findFirst(demoTrace.prd.sections, (section) => section.id === id),
    ).level;
    assert(searchedSectionOf(demoTrace, Option.some(sectionNode(id)))).toStrictEqual(
      level > 1 ? Option.some(prd(id)) : Option.none(),
    );
  },
);

it("nothing active has no current section", () => {
  assert(searchedSectionOf(demoTrace, Option.none())).toStrictEqual(Option.none());
});

it.prop(
  "a result always has somewhere to scroll, each target with a selector",
  { query: Schema.Literals(["trailer", "stkorder", "format", "judgment", "viewer"]) },
  ({ query }) => {
    Array.forEach(searchTrace(demoTrace, query), (result) => {
      const targets = targetsOf(result);
      assert(Array.isReadonlyArrayNonEmpty(targets)).toBe(true);
      Array.forEach(targets, (target) =>
        assert(Array.isReadonlyArrayNonEmpty(target.selectors)).toBe(true),
      );
    });
  },
  // Five queries, each searching the whole demo trace. The default 100 runs pass the test's limit
  // when the whole check runs beside them; 10 still draws every query.
  { arbitrary: { runs: 10 } },
);
