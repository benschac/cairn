import { UiStruct } from "@effect/ui";
import { PrdSectionId, SectionId, TaskId, type Trace } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, HashSet, Option, Record, Struct } from "effect";

import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen, TraceData } from "../src/model.ts";
import { cardsOf, countsOf, itemSpecsOf } from "../src/reader.ts";
import { chainOf } from "../src/trace.ts";
import { linksOf, type Measured } from "../src/wires.ts";
import { CopySectionId, ScrollPrdSection, update } from "../src/update.ts";
import {
  attr,
  both,
  containing,
  data,
  detailDividerRunning,
  dividersRunning,
  focusedHeading,
  inside,
  loaded,
  notContaining,
  nth,
  prdScrolledTo,
  stacksScrolled,
  wiresMeasuredAs,
  pushedUrl,
  readerMounted,
  resolved,
  tag,
  unfolded,
  viewerScene,
  type ViewerSteps,
} from "./fixtures.ts";

const prd = (id: string) => PrdSectionId.make(id);

/** The demo trace's PRD has an ID on each of the CLI section's commands. */
const SECTION = "prd.cli";
const LINT = "prd.cli.lint";
const LINT_SPEC = "spec.lint";

const commands = Array.filter(demoTrace.prd.items, (item) => item.section === SECTION);
const lintTasks = Array.filter(demoTrace.tasks, (task) =>
  Array.some(task.specSections, (id) => id === LINT_SPEC),
);
const chainOfPrd = (trace: Trace, id: string) =>
  chainOf(trace, { id: SectionId.make(id), kind: "section" });

/** Every stack open, so each task has a chip to light. */
const reading = unfolded(UiStruct.evolve(loaded, { screen: () => Screen.Reader() }));

const prdPane = data("prd-pane");
const specPane = data("spec-pane");
const stacks = data("stacks-pane");
const item = (id: string) => inside(prdPane, both(data("item", id), data("wire", `prd:${id}`)));
const annotation = (id: string) => inside(item(id), data("item-annotation", id));
const idButton = (id: string) => inside(item(id), data("item-id", id));
const card = (id: string) => data("spec", id);
const cards = inside(specPane, data("spec"));
const dimmedCards = inside(specPane, both(data("spec"), data("dimmed")));
const row = (spec: string, task: string) => data("task-row", `${spec}:${task}`);
const chip = (id: string) => inside(stacks, data("task", id));
const litChips = inside(stacks, both(data("task"), data("current")));

/** What an annotation reads for an item: its chain's counts, or that nothing maps to it. */
const annotationText = (trace: Trace, id: string): string => {
  const counts = countsOf(trace, prd(id));
  return counts.specs === 0 && counts.tasks === 0
    ? "nothing maps to this"
    : `${counts.specs} spec · ${counts.done}/${counts.tasks} tasks`;
};

/** The reader with the item pinned, as a click on its annotation leaves it. */
const pinnedItem = (id: string) => (s: ViewerSteps) =>
  s.pipe(readerMounted).click(annotation(id)).pipe(pushedUrl);

it("the demo trace has IDs on the CLI section's commands and the lint spec has tasks", () => {
  assert(Array.length(commands)).toBeGreaterThanOrEqual(10);
  assert(Array.some(commands, (command) => command.id === LINT)).toBe(true);
  assert(Array.length(lintTasks)).toBeGreaterThan(1);
});

it.effect("each command shows its own annotation, with no {#id} left in its text", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .expect(inside(prdPane, data("item")))
      .toHaveCount(Array.length(demoTrace.prd.items));
    Array.forEach(commands, (command) => {
      s.expect(annotation(command.id))
        .toHaveText(containing(annotationText(demoTrace, command.id)))
        .expect(item(command.id))
        .toHaveText(notContaining(`{#${command.id}}`))
        .expect(inside(item(command.id), data("item-annotation")))
        .toHaveCount(1);
    });
    s.expect(annotation(LINT)).toHaveText(containing("1 spec · 7/7 tasks"));
  }),
);

it.effect("an item that nothing maps to says so in its annotation's place", () =>
  Effect.gen(function* () {
    const unmapped = "prd.cli.stats";
    const withoutIt: Trace = Struct.evolve(demoTrace, {
      spec: (spec) =>
        Struct.evolve(spec, {
          sections: Array.map((section) =>
            Struct.evolve(section, {
              keys: (keys) =>
                Struct.evolve(keys, {
                  implements: Array.filter((id: string) => id !== unmapped),
                }),
            }),
          ),
        }),
    });
    assert(annotationText(withoutIt, unmapped)).toBe("nothing maps to this");
    const s = yield* viewerScene(
      UiStruct.evolve(reading, { trace: () => TraceData.Success({ data: withoutIt }) }),
    );
    s.pipe(readerMounted)
      .expect(annotation(unmapped))
      .toHaveText(containing("nothing maps to this"))
      .expect(annotation(unmapped))
      .toHaveText(notContaining("spec ·"))
      .expect(annotation(LINT))
      .toHaveText(containing("1 spec"));
  }),
);

it.effect("an item's annotation is a native button with a status dot, beside its ID button", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .expect(both(annotation(LINT), tag("button")))
      .toExist()
      .expect(annotation(LINT))
      .toHaveAttribute("aria-pressed", "false")
      .expect(inside(annotation(LINT), data("status", "done")))
      .toExist()
      .expect(idButton(LINT))
      .toHaveText(LINT)
      .expect(idButton(LINT))
      .toHaveAttribute("aria-label", `Copy the item ID ${LINT}`);
  }),
);

it.effect("clicking an item's ID copies it through the section ID command", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(idButton(LINT))
      .pipe(
        resolved(CopySectionId, Message.CompletedCopySectionId({ id: prd(LINT), isCopied: true })),
      )
      .expect(idButton(LINT))
      .toHaveText("copied");
  }),
);

it.effect("the heading's status line counts its items with it", () =>
  Effect.gen(function* () {
    const counts = countsOf(demoTrace, prd(SECTION));
    const lint = countsOf(demoTrace, prd(LINT));
    assert(counts.tasks).toBeGreaterThanOrEqual(lint.tasks);
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .expect(data("status-line", SECTION))
      .toHaveText(containing(`${counts.specs} spec · ${counts.done}/${counts.tasks} tasks`));
  }),
);

it.effect("pinning prd.cli.lint leaves lit only the cards that implement it and its tasks", () =>
  Effect.gen(function* () {
    const implementing = Array.map(
      Array.filter(demoTrace.spec.sections, (section) =>
        Array.some(section.keys.implements, (id) => id === LINT),
      ),
      (section) => section.id,
    );
    assert(implementing).toStrictEqual([LINT_SPEC]);
    const lit = Array.fromIterable(chainOfPrd(demoTrace, LINT).tasks);
    assert(Array.length(lit)).toBe(Array.length(lintTasks));
    const outside = Option.getOrThrow(
      Array.findFirst(demoTrace.tasks, (task) => !Array.contains(lit, task.id)),
    );
    const s = yield* viewerScene(reading);
    s.pipe(pinnedItem(LINT))
      .expect(annotation(LINT))
      .toHaveAttribute("aria-pressed", "true")
      .expect(item(LINT))
      .toHaveAttribute("data-current", "")
      .expect(cards)
      .toHaveCount(1)
      .expect(card(LINT_SPEC))
      .toExist()
      .expect(inside(specPane, data("task-row")))
      .toHaveCount(Array.length(lintTasks))
      .expect(litChips)
      .toHaveCount(Array.length(lit))
      .expect(chip(outside.id))
      .toHaveAttribute("data-current", false)
      .expect(annotation("prd.cli.init"))
      .toHaveAttribute("aria-pressed", "false");
  }),
);

it.effect("clicking the annotation again, or Escape, unpins the item", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(pinnedItem(LINT))
      .click(annotation(LINT))
      .pipe(pushedUrl)
      .expect(annotation(LINT))
      .toHaveAttribute("aria-pressed", "false")
      .expect(item(LINT))
      .toHaveAttribute("data-current", false)
      .click(annotation(LINT))
      .pipe(pushedUrl)
      .expect(annotation(LINT))
      .toHaveAttribute("aria-pressed", "true")
      .fireDocument("keydown", { key: "Escape" })
      .pipe(pushedUrl)
      .expect(annotation(LINT))
      .toHaveAttribute("aria-pressed", "false");
  }),
);

it.effect("hovering an annotation lights the item's chain and dims the other cards", () =>
  Effect.gen(function* () {
    const sectionSpecs = Array.length(Array.fromIterable(chainOfPrd(demoTrace, SECTION).spec));
    assert(sectionSpecs).toBeGreaterThan(1);
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(data("status-line", SECTION))
      .pipe(pushedUrl)
      .expect(cards)
      .toHaveCount(sectionSpecs)
      .expect(dimmedCards)
      .toHaveCount(0)
      .fire(annotation(LINT), "mouseenter")
      .expect(dimmedCards)
      .toHaveCount(sectionSpecs - 1)
      .expect(card(LINT_SPEC))
      .toHaveAttribute("data-dimmed", false)
      .expect(row(LINT_SPEC, "t27"))
      .toHaveAttribute("data-dimmed", false)
      .fire(annotation(LINT), "mouseleave")
      .expect(dimmedCards)
      .toHaveCount(0);
  }),
);

it.effect("opening one of those tasks lists prd.cli.lint with the section it is in", () =>
  Effect.gen(function* () {
    // A task with no commits asks for no diff, so the panel opens with the heading's focus alone.
    const task = Option.getOrThrow(
      Array.findFirst(lintTasks, (each) => Array.isReadonlyArrayEmpty(each.commits)),
    );
    const built = Array.filter(demoTrace.prd.items, (candidate) =>
      HashSet.has(chainOf(demoTrace, { id: task.id, kind: "task" }).prd, candidate.id),
    );
    assert(Array.some(built, (candidate) => candidate.id === LINT)).toBe(true);
    const s = yield* viewerScene(reading);
    s.pipe(pinnedItem(LINT))
      .click(row(LINT_SPEC, task.id))
      .pipe(pushedUrl, focusedHeading, detailDividerRunning)
      .expect(data("detail-item", LINT))
      .toHaveText(`${LINT} · in CLI`)
      .expect(inside(data("detail"), data("detail-item")))
      .toHaveCount(Array.length(built));
  }),
);

it.effect("hovering a task row marks the items it builds, and only those", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(pinnedItem(LINT))
      .expect(item(LINT))
      .toHaveAttribute("data-marked", false)
      .fire(row(LINT_SPEC, "t27"), "mouseenter")
      .expect(item(LINT))
      .toHaveAttribute("data-marked", "")
      .expect(inside(prdPane, data("marked")))
      .toHaveCount(1)
      .fire(row(LINT_SPEC, "t27"), "mouseleave")
      .expect(item(LINT))
      .toHaveAttribute("data-marked", false);
  }),
);

const outsideTask = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (task) => !Array.contains(lintTasks, task)),
);

it.effect(
  "clicking an Implements chip scrolls the PRD to the item and marks it until a hover",
  () =>
    Effect.gen(function* () {
      const chips = inside(card(LINT_SPEC), both(attr("data-key", "Implements"), tag("button")));
      const s = yield* viewerScene(
        UiStruct.evolve(reading, {
          reader: (reader) =>
            UiStruct.evolve(reader, {
              opened: () => Record.singleton(SectionId.make(LINT_SPEC), true),
            }),
        }),
      );
      s.pipe(pinnedItem(LINT))
        // The spec's own Implements list: a button for each PRD section or item it names.
        .expect(chips)
        .toHaveCount(4)
        .expect(nth(chips, 3))
        .toHaveText(LINT)
        .expect(item(LINT))
        .toHaveAttribute("data-marked", false)
        .click(nth(chips, 3))
        .pipe(resolved(ScrollPrdSection, Message.CompletedScrollPrdSection()))
        .expect(item(LINT))
        .toHaveAttribute("data-marked", "")
        // A chip that names a heading marks the heading, and only it.
        .click(nth(chips, 0))
        .pipe(resolved(ScrollPrdSection, Message.CompletedScrollPrdSection()))
        .expect(item(LINT))
        .toHaveAttribute("data-marked", false)
        .expect(inside(prdPane, both(data("section", SECTION), data("marked"))))
        .toExist()
        // Hovering another node, not the item's own tasks, ends the mark.
        .fire(chip(outsideTask.id), "mouseenter")
        .expect(inside(prdPane, data("marked")))
        .toHaveCount(0);
    }),
);

it("a chip click sends the PRD pane to the item, and opens its section when it is folded", () => {
  const target = Option.getOrThrow(
    Array.findFirst(demoTrace.prd.items, (each) => each.id === LINT),
  );
  const folded = UiStruct.evolve(reading, {
    reader: (reader) =>
      UiStruct.evolve(reader, {
        isPrdCondensed: () => true,
        prdOpened: () => Record.singleton(SectionId.make("prd.goal"), true),
      }),
  });
  const { commands: issued, model } = update(
    folded,
    Message.ClickedImplementsChip({ id: prd(LINT) }),
  );
  assert(
    Array.map(
      Option.getOrElse(Option.fromNullishOr(issued), () => []),
      (command) => [command.name, command.args],
    ),
  ).toEqual([["ScrollPrdSection", { id: LINT }]]);
  assert(model.reader.maybeMarked).toEqual(Option.some(prd(LINT)));
  assert(Record.get(model.reader.prdOpened, target.section)).toEqual(Option.some(true));
});

it("a message that is not a chip click ends the mark", () => {
  const marked = update(reading, Message.ClickedImplementsChip({ id: prd(LINT) })).model;
  assert(marked.reader.maybeMarked).toEqual(Option.some(prd(LINT)));
  Array.forEach(
    [
      Message.PressedEscape(),
      Message.HoveredNode({ node: { id: outsideTask.id, kind: "task" } }),
      Message.ClickedItemAnnotation({ id: prd(LINT) }),
      Message.ClickedStatusLine({ id: prd(SECTION) }),
      Message.ClickedTask({ id: outsideTask.id }),
    ],
    (message) => {
      assert(update(marked, message).model.reader.maybeMarked).toEqual(Option.none());
    },
  );
  assert(update(marked, Message.LeftNode()).model.reader.maybeMarked).toEqual(
    Option.some(prd(LINT)),
  );
});

it("clicking an item's annotation pins it as a status line does", () => {
  const pinned = update(reading, Message.ClickedItemAnnotation({ id: prd(LINT) })).model;
  assert(pinned.reader.maybePinned).toEqual(Option.some(prd(LINT)));
  assert(
    update(pinned, Message.ClickedItemAnnotation({ id: prd(LINT) })).model.reader.maybePinned,
  ).toEqual(Option.none());
  assert(
    update(pinned, Message.ClickedItemAnnotation({ id: prd("prd.cli.init") })).model.reader
      .maybePinned,
  ).toEqual(Option.some(prd("prd.cli.init")));
});

const wireLayer = data("wire-layer");
const pathBetween = (source: string, target: string) =>
  inside(
    wireLayer,
    both(both(tag("path"), data("wire-source", source)), data("wire-target", target)),
  );

/** The heading, the item and the spec card they both end on, each with a box in its own pane. */
const measuredEnds: Measured = {
  boxes: {
    [`prd:${SECTION}`]: { height: 24, width: 120, x: 10, y: 100 },
    [`prd:${LINT}`]: { height: 24, width: 120, x: 10, y: 200 },
    [`spec:${LINT_SPEC}`]: { height: 24, width: 120, x: 510, y: 100 },
  },
  panes: {
    prd: { height: 4000, width: 500, x: 0, y: 50 },
    spec: { height: 4000, width: 400, x: 500, y: 50 },
    stacks: { height: 4000, width: 300, x: 900, y: 50 },
  },
};

it("linksOf adds a curve from each item under the section to each of its cards", () => {
  const items = itemSpecsOf(demoTrace, prd(SECTION));
  assert(Array.map(items, (each) => each.id)).toStrictEqual(
    Array.map(commands, (command) => command.id),
  );
  const links = linksOf(prd(SECTION), cardsOf(demoTrace, prd(SECTION)), undefined, items);
  assert(
    Array.some(
      links,
      (link) => link.source === `prd:${LINT}` && link.target === `spec:${LINT_SPEC}`,
    ),
  ).toBe(true);
  // An item curve starts at its item and ends at one of the item's own cards.
  Array.forEach(items, (each) => {
    const ends = Array.map(
      Array.filter(links, (link) => link.source === `prd:${each.id}`),
      (link) => link.target,
    );
    assert(ends).toStrictEqual(Array.map(each.specs, (spec) => `spec:${spec}`));
  });
});

it.effect("the curve from an item to its card is lit while the item's annotation is hovered", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(dividersRunning, prdScrolledTo(SECTION), stacksScrolled, wiresMeasuredAs(measuredEnds))
      .expect(inside(wireLayer, tag("path")))
      .toHaveCount(2)
      .expect(pathBetween(`prd:${LINT}`, `spec:${LINT_SPEC}`))
      .toExist()
      .expect(pathBetween(`prd:${SECTION}`, `spec:${LINT_SPEC}`))
      .toExist()
      .fire(annotation(LINT), "mouseenter")
      .expect(inside(wireLayer, both(tag("path"), data("lit"))))
      .toHaveCount(1)
      .expect(both(pathBetween(`prd:${LINT}`, `spec:${LINT_SPEC}`), data("lit")))
      .toExist()
      .expect(both(pathBetween(`prd:${SECTION}`, `spec:${LINT_SPEC}`), data("dimmed")))
      .toExist();
  }),
);

it.effect("a detail item in a folded section opens the section and scrolls to the item", () =>
  Effect.gen(function* () {
    const folded = UiStruct.evolve(reading, {
      detail: () => [{ id: TaskId.make("t110"), kind: "task" as const }],
      reader: (reader) => UiStruct.evolve(reader, { isPrdCondensed: () => true }),
    });
    // The item is not in the page while its section is folded; the update opens the section.
    const { commands: issued, model } = update(
      folded,
      Message.ClickedTraceSection({ id: prd(LINT) }),
    );
    assert(
      Array.map(
        Option.getOrElse(Option.fromNullishOr(issued), () => []),
        (command) => command.name,
      ),
    ).toEqual(["ScrollPrdSection"]);
    assert(Record.get(model.reader.prdOpened, SectionId.make(SECTION))).toEqual(Option.some(true));
    // A heading needs nothing opened, and clicking one marks nothing.
    const heading = update(folded, Message.ClickedTraceSection({ id: prd(SECTION) })).model;
    assert(heading.reader.prdOpened).toEqual(folded.reader.prdOpened);
    assert(heading.reader.maybeMarked).toEqual(Option.none());
    const s = yield* viewerScene(folded);
    s.pipe(readerMounted, detailDividerRunning)
      .expect(item(LINT))
      .toHaveCount(0)
      .click(data("detail-item", LINT))
      .pipe(resolved(ScrollPrdSection, Message.CompletedScrollPrdSection()))
      .expect(item(LINT))
      .toExist();
  }),
);
