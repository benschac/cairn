import { UiStruct } from "@effect/ui";
import { PrdSectionId, SectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Effect, Array, HashSet, Option, Record, Schema, String } from "effect";

import { FocusSearchInput, ScrollSearchResult } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { cardsOf, isCardless, searchedSectionOf, targetsOf } from "../src/reader.ts";
import { NO_SEARCH, queried, searchTrace, type SearchResult } from "../src/search.ts";
import { chainOf, nodeKeyOf, type Node } from "../src/trace.ts";
import { ScrollSearchTargets } from "../src/update.ts";
import { PressDivider } from "../src/view/dividerView.ts";
import { linksOf, type Measured, type Panes } from "../src/wires.ts";
import {
  attr,
  both,
  byRole,
  data,
  dividersRunning,
  inside,
  loaded,
  prdScrolledTo,
  pushedUrl,
  resolved,
  stacksScrolled,
  tag,
  unfolded,
  unmeasuredWires,
  viewerScene,
  wiresMeasuredAs,
  type ViewerSteps,
} from "./fixtures.ts";

const reading = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });
/** Stack 13's trunk, t19 and t20, is folded in `reading`; these scenes look at t20's chip. */
const unfoldedReading = unfolded(reading);

const prd = (id: string) => PrdSectionId.make(id);
const sectionNode = (id: string): Node => ({
  id: Schema.decodeSync(SectionId)(id),
  kind: "section",
});
const taskNode = (id: string): Node => ({ id: TaskId.make(id), kind: "task" });

const searchBox = byRole("combobox", { name: "Search sections and tasks" });
const status = data("search-status");
const option = (node: Node) => data("search-result", nodeKeyOf(node));

const heading = (id: string) => inside(data("prd-pane"), data("section", id));
const statusLine = (id: string) => data("status-line", id);
const card = (id: string) => data("spec", id);
const row = (id: string) => data("task-row", "spec.planning.stack-order:" + id);
const chip = (id: string) => inside(data("stacks-pane"), data("task", id));
const panel = data("detail");
const mark = data("search-match");
const searched = data("searched");
const dimmed = data("dimmed");

const PINNED = "prd.viewer.reader";
/** The mounts the reader starts, answered as a page with this measurement would. */
const mounted = (measured: Measured) => (s: ViewerSteps) =>
  s.pipe(dividersRunning, prdScrolledTo("prd.goal"), stacksScrolled, wiresMeasuredAs(measured));

const unmeasured = unmeasuredWires;

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
const wireCount = Array.length(linksOf(prd(MANIFEST), cardsOf(demoTrace, prd(MANIFEST))));
const stackOrderTasks = Array.length(
  Array.filter(demoTrace.tasks, (task) =>
    Array.some(task.specSections, (id) => String.Equivalence(id, STACK_ORDER.id)),
  ),
);

/** Moving the active search result scrolls the list to it; the test answers for the scroll. */
const scrolledSearchResult = resolved(ScrollSearchResult, Message.CompletedScrollSearchResult());

/** Clicking a search result takes focus from the input, so it is moved back; the test answers for it. */
const focusedSearchInput = resolved(FocusSearchInput, Message.CompletedFocusSearchInput());

/**
 * A selected result scrolls its targets into view; the test answers for it. Effect UI matches a
 * pending Command by definition, not by its arguments, so the targets are no longer asserted.
 */
const scrolledTargets = (s: ViewerSteps) =>
  s.resolve(ScrollSearchTargets, Message.CompletedScrollSearchTargets());

const litPaths = inside(data("wire-layer"), both(tag("path"), data("lit")));
const faintPaths = inside(data("wire-layer"), both(tag("path"), data("dimmed")));

it.effect(
  "selecting a PRD section scrolls the PRD to its heading and makes it current, keeping the pin",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(mounted(unmeasured))
        .click(statusLine(PINNED))
        .pipe(pushedUrl)
        .expect(heading(PINNED))
        .toHaveAttribute("data-current", "")
        .type(searchBox, "fuzzy search")
        .pipe(scrolledSearchResult)
        .expect(status)
        .toHaveText(Array.length(searchTrace(demoTrace, "fuzzy search")) + " results.")
        // The active result is current ahead of the pin, outlined and marked in its heading.
        .expect(heading("prd.viewer.fuzzy-search"))
        .toHaveAttribute("data-searched", "active")
        .expect(heading("prd.viewer.fuzzy-search"))
        .toHaveAttribute("data-current", "")
        .expect(heading(PINNED))
        .toHaveAttribute("data-current", false)
        .expect(inside(heading("prd.viewer.fuzzy-search"), mark))
        .toExist()
        .expect(statusLine(PINNED))
        .toHaveAttribute("aria-pressed", "true")
        // Nothing is scrolled until a result is selected.
        .keydown(searchBox, "Enter")
        .expectHandled()
        .pipe(scrolledTargets)
        // Escape clears the search and its marks; the pin is current again and is still pinned.
        .keydown(searchBox, "Escape")
        .expectHandled()
        .expect(searched)
        .toHaveCount(0)
        .expect(mark)
        .toHaveCount(0)
        .expect(heading(PINNED))
        .toHaveAttribute("data-current", "")
        .expect(statusLine(PINNED))
        .toHaveAttribute("aria-pressed", "true");
    }),
);

it.effect(
  "a spec section makes its first PRD section current, lights only its own curves and scrolls its card",
  () =>
    Effect.gen(function* () {
      const litWires = 1 + stackOrderTasks;
      const s = yield* viewerScene(unfoldedReading);
      s.pipe(mounted(measuredFor(MANIFEST)))
        .click(statusLine(PINNED))
        .pipe(pushedUrl)
        .type(searchBox, "stkorder")
        .pipe(scrolledSearchResult)
        // The chain's first PRD section in document order, not the pin; the pin is untouched.
        .expect(heading(MANIFEST))
        .toHaveAttribute("data-current", "")
        .expect(heading(PINNED))
        .toHaveAttribute("data-current", false)
        .expect(statusLine(PINNED))
        .toHaveAttribute("aria-pressed", "true")
        .expect(card(STACK_ORDER.id))
        .toHaveAttribute("data-searched", "active")
        .expect(inside(card(STACK_ORDER.id), mark))
        .toExist()
        .expect(chip("t20"))
        .toHaveAttribute("data-searched", "match")
        // Only the active result's chain is previewed: its curves are lit, every other is faint.
        .expect(litPaths)
        .toHaveCount(litWires)
        .expect(faintPaths)
        .toHaveCount(wireCount - litWires)
        .expect(chip("t9"))
        .toHaveAttribute("data-dimmed", "")
        .expect(chip("t20"))
        .toHaveAttribute("data-dimmed", false)
        .keydown(searchBox, "Enter")
        .expectHandled()
        .pipe(scrolledTargets)
        // Hovering is the top preview, and leaving it falls back to the search.
        .fire(chip("t9"), "mouseenter")
        .expect(chip("t20"))
        .toHaveAttribute("data-dimmed", "")
        .fire(chip("t9"), "mouseleave")
        .expect(chip("t20"))
        .toHaveAttribute("data-dimmed", false)
        .expect(litPaths)
        .toHaveCount(litWires)
        .keydown(searchBox, "Escape")
        .expect(dimmed)
        .toHaveCount(0)
        .expect(litPaths)
        .toHaveCount(0)
        .expect(heading(PINNED))
        .toHaveAttribute("data-current", "");
    }),
);

it.effect("a task scrolls its row and its chip, and its chain is the one previewed", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(unfoldedReading);
    s.pipe(mounted(measuredFor(MANIFEST)))
      .type(searchBox, "stkorder")
      .pipe(scrolledSearchResult)
      .keydown(searchBox, "ArrowDown")
      .pipe(scrolledSearchResult)
      .expect(heading(MANIFEST))
      .toHaveAttribute("data-current", "")
      .expect(row("t20"))
      .toHaveAttribute("data-searched", "active")
      .expect(chip("t20"))
      .toHaveAttribute("data-searched", "active")
      .expect(card(STACK_ORDER.id))
      .toHaveAttribute("data-searched", "match")
      .expect(litPaths)
      .toHaveCount(2)
      .expect(chip("t9"))
      .toHaveAttribute("data-dimmed", "")
      .keydown(searchBox, "Enter")
      .expectHandled()
      .pipe(scrolledTargets);
  }),
);

it.effect(
  "a spec section that implements no PRD section opens in the detail panel, and clearing keeps it open",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(mounted(unmeasured))
        .click(statusLine(PINNED))
        .pipe(pushedUrl)
        .type(searchBox, "format")
        .pipe(scrolledSearchResult)
        // Moving to it only previews: it has no card, so the pin stays current and nothing opens.
        .expect(heading(PINNED))
        .toHaveAttribute("data-current", "")
        .expect(panel)
        .toBeAbsent()
        .keydown(searchBox, "Enter")
        .expectHandled()
        .pipe(pushedUrl)
        .expectMount(PressDivider({ pane: "detail" }))
        .expect(panel)
        .toHaveAttribute("data-detail-id", "spec.format")
        .expect(heading(PINNED))
        .toHaveAttribute("data-current", "")
        .keydown(searchBox, "Escape")
        .expectHandled()
        .expect(searchBox)
        .toHaveValue("")
        .expect(panel)
        .toHaveAttribute("data-detail-id", "spec.format")
        .expect(statusLine(PINNED))
        .toHaveAttribute("aria-pressed", "true");
    }),
);

it.effect(
  "a click on a result selects it and returns focus to search, and a task result does not open the panel",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(mounted(unmeasured))
        .type(searchBox, "stkorder")
        .pipe(scrolledSearchResult)
        .click(option(taskNode("t20")))
        .pipe(scrolledTargets, focusedSearchInput)
        .expect(option(taskNode("t20")))
        .toHaveAttribute("aria-selected", "true")
        .expect(row("t20"))
        .toHaveAttribute("data-searched", "active")
        .expect(panel)
        .toBeAbsent()
        .expect(data("pins"))
        .toHaveCount(0);
    }),
);

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

it.effect(
  "selecting prose in the PRD scrolls to the matched block, falling back to its heading",
  () =>
    Effect.gen(function* () {
      const found = proseOf("trailer", isPrd);
      const offset = Option.getOrThrow(found.maybeOffset);
      const s = yield* viewerScene(reading);
      s.pipe(mounted(unmeasured))
        .type(searchBox, "trailer")
        .pipe(scrolledSearchResult)
        .click(option(found.node))
        .pipe(scrolledTargets, focusedSearchInput)
        .expect(inside(data("block", "prd:" + offset), mark))
        .toExist()
        .expect(heading(found.node.id))
        .toHaveAttribute("data-searched", "active");
    }),
);

it.effect(
  "a card holding the active result's prose is open while it is active, whatever the density",
  () =>
    Effect.gen(function* () {
      const found = proseOf("judgment", isSpec);
      const section = Option.getOrThrow(searchedSectionOf(demoTrace, Option.some(found.node)));
      const offset = Option.getOrThrow(found.maybeOffset);
      const searching = UiStruct.evolve(reading, {
        reader: (reader) =>
          UiStruct.evolve(reader, {
            density: () => "titles",
            maybePinned: () => Option.some(section),
          }),
        search: () => queried(NO_SEARCH, Option.some(demoTrace), "judgment"),
      });
      const header = inside(data("spec", found.node.id), attr("aria-expanded"));
      const full = data("full-spec", found.node.id);
      // The query has results, none of them active: the card is closed.
      const closed = yield* viewerScene(
        UiStruct.evolve(searching, {
          search: (search) => UiStruct.evolve(search, { maybeActive: () => Option.none() }),
        }),
      );
      closed
        .pipe(mounted(unmeasured))
        .expect(header)
        .toHaveAttribute("aria-expanded", "false")
        .expect(full)
        .toBeAbsent();
      const open = yield* viewerScene(
        UiStruct.evolve(searching, {
          search: (search) =>
            UiStruct.evolve(search, { maybeActive: () => Option.some(found.node) }),
        }),
      );
      open
        .pipe(mounted(unmeasured))
        .expect(header)
        .toHaveAttribute("aria-expanded", "true")
        .expect(card(found.node.id))
        .toHaveAttribute("data-searched", "active")
        .expect(inside(full, data("block", "spec:" + offset)))
        .toExist()
        .expect(inside(full, mark))
        .toExist();
    }),
);

it.effect("a query with no match says so and leaves the panes usable and undimmed", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(mounted(unmeasured))
      .click(statusLine(PINNED))
      .pipe(pushedUrl)
      .type(searchBox, "zzzzqqqq")
      .expect(status)
      .toHaveText("No results.")
      .expect(heading(PINNED))
      .toHaveAttribute("data-current", "")
      .expect(dimmed)
      .toHaveCount(0)
      .expect(searched)
      .toHaveCount(0)
      .keydown(searchBox, "Enter")
      .expectHandled()
      .click(statusLine(PINNED))
      .pipe(pushedUrl)
      .expect(statusLine(PINNED))
      .toHaveAttribute("aria-pressed", "false");
  }),
);

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
