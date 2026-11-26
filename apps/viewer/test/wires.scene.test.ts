import { UiStruct } from "@effect/ui";
import { PrdSectionId, type TraceTask } from "@cairn/contract";
import { assert, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Array, Effect, HashSet, Option, Record, String } from "effect";

import { demoTrace } from "../src/demo.ts";
import type { Rect } from "../src/geometry.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { cardsOf, type Cards } from "../src/reader.ts";
import { chainOf } from "../src/trace.ts";
import { CopySectionId } from "../src/update.ts";
import { linksOf, rowKey, specKey, taskKey, type Measured, type Panes } from "../src/wires.ts";
import {
  both,
  data,
  dividersRunning,
  forEachStep,
  inside,
  loaded,
  nodesWithAttr,
  prdScrolledTo,
  resolved,
  sameNodes,
  stacksScrolled,
  styleDeclaring,
  tag,
  unmeasuredWires,
  viewerScene,
  type ViewerSteps,
  wiresMeasuredAs,
} from "./fixtures.ts";

const reading = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });

/** Three side-by-side panes, tall enough that nothing measured below is out of view. */
const panes: Panes = {
  prd: { height: 4000, width: 500, x: 0, y: 50 },
  spec: { height: 4000, width: 400, x: 500, y: 50 },
  stacks: { height: 4000, width: 300, x: 900, y: 50 },
};

const paneOf = (key: string): Rect =>
  String.startsWith("prd:")(key)
    ? panes.prd
    : String.startsWith("task:")(key)
      ? panes.stacks
      : panes.spec;

/** Every key given a box in its own pane, one below the other. */
const measuredFor = (keys: ReadonlyArray<string>): Measured => ({
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
});

const keysOf = (links: ReadonlyArray<{ source: string; target: string }>) =>
  Array.dedupe(Array.flatMap(links, (link) => [link.source, link.target]));

const prd = (id: string) => PrdSectionId.make(id);

/** The reader on the section, with its mounts answered: the pane found it at the top, and the body measured `measured`. */
const opened = (id: string, measured: Measured) => (s: ViewerSteps) =>
  s.pipe(dividersRunning, prdScrolledTo(id), stacksScrolled, wiresMeasuredAs(measured));

const wireLayer = data("wire-layer");
const paths = inside(wireLayer, tag("path"));
const pathOf = (source: string, target: string) =>
  inside(
    wireLayer,
    both(both(tag("path"), data("wire-source", source)), data("wire-target", target)),
  );
const lit = inside(wireLayer, both(tag("path"), data("lit")));
const faint = inside(wireLayer, both(tag("path"), data("dimmed")));
const dimmedCards = inside(data("spec-pane"), both(data("spec"), data("dimmed")));
const anyDimmed = data("dimmed");
const specCard = (id: string) => data("spec", id);
const header = (id: string) => inside(specCard(id), data("wire", specKey(id)));
const row = (spec: string, id: string) => data("wire", rowKey(spec, id));
const chip = (id: string) => inside(data("stacks-pane"), data("wire", taskKey(id)));

interface Example {
  readonly prd: PrdSectionId;
  readonly cards: Cards;
  /** A task listed in one card only, and that card's section. */
  readonly task: TraceTask;
  readonly spec: string;
  /** Another card, which the task is not in. */
  readonly other: string;
  /** A task listed in the first card, and not the hovered task. */
  readonly neighbour: TraceTask;
}

/** A section of the demo trace with two cards and a task that only one of them lists. */
const exampleOf = (): Example =>
  Option.getOrThrow(
    Array.findFirst(
      Array.getSomes(
        Array.map(demoTrace.prd.sections, (section): Option.Option<Example> => {
          const cards = cardsOf(demoTrace, prd(section.id));
          return Option.flatMap(Array.head(cards.cards), (first) =>
            Option.flatMap(Array.get(cards.cards, 1), (second) =>
              Option.flatMap(
                Array.findFirst(
                  first.tasks,
                  (task) =>
                    !Array.some(task.specSections, (id) =>
                      String.Equivalence(id, second.section.id),
                    ),
                ),
                (task) =>
                  Option.map(
                    Array.findFirst(first.tasks, (candidate) => candidate.id !== task.id),
                    (neighbour) => ({
                      cards,
                      neighbour,
                      other: second.section.id,
                      prd: prd(section.id),
                      spec: first.section.id,
                      task,
                    }),
                  ),
              ),
            ),
          );
        }),
      ),
      () => true,
    ),
  );

const example = exampleOf();
const links = linksOf(example.prd, example.cards);
const everything = measuredFor(keysOf(links));

it("the example is a section with two cards, a task one lists and a neighbour in that card", () => {
  expect(Array.length(example.cards.cards)).toBeGreaterThanOrEqual(2);
  expect(Array.isReadonlyArrayNonEmpty(links)).toBe(true);
  expect(example.task.id).not.toBe(example.neighbour.id);
});

it.effect("the elements a curve ends on carry their keys in data-wire", () =>
  Effect.gen(function* () {
    const first = Option.getOrThrow(Array.head(example.cards.cards));
    const s = yield* viewerScene(
      UiStruct.evolve(reading, {
        reader: (reader) =>
          UiStruct.evolve(reader, { maybePinned: () => Option.some(example.prd) }),
      }),
    );
    s.pipe(opened(example.prd, everything))
      .expect(inside(data("prd-pane"), data("section", example.prd)))
      .toHaveAttribute("data-wire", `prd:${example.prd}`)
      .expect(header(first.section.id))
      .toExist()
      .pipe(
        forEachStep(first.tasks, (step, task) =>
          step.expect(row(first.section.id, task.id)).toExist(),
        ),
        forEachStep(first.tasks, (step, task) => step.expect(chip(task.id)).toExist()),
      )
      .expect(inside(data("prd-pane"), data("wire")))
      .toHaveCount(1);
  }),
);

it.effect("with every end measured, there is one path for each link of the section", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(opened(example.prd, everything))
      .expect(paths)
      .toHaveCount(Array.length(links))
      .expect(wireLayer)
      .toHaveAttribute("aria-hidden", "true")
      .expect(wireLayer)
      .toHaveAttribute("style", styleDeclaring("pointer-events", "none"))
      .expect(wireLayer)
      .toHaveAttribute("style", styleDeclaring("position", "fixed"))
      .pipe(
        forEachStep(links, (step, link) => step.expect(pathOf(link.source, link.target)).toExist()),
      )
      .expect(lit)
      .toHaveCount(0)
      .expect(faint)
      .toHaveCount(0)
      .expect(dimmedCards)
      .toHaveCount(0)
      .expect(anyDimmed)
      .toHaveCount(0);
  }),
);

it.effect(
  "a link whose end is not measured has no path, and nothing is drawn before anything is measured",
  () =>
    Effect.gen(function* () {
      const unmeasured = Option.getOrThrow(Array.head(links));
      const missing: Measured = {
        boxes: Record.remove(everything.boxes, unmeasured.target),
        panes,
      };
      const partly = yield* viewerScene(reading);
      partly
        .pipe(opened(example.prd, missing))
        .expect(paths)
        .toHaveCount(Array.length(links) - 1)
        .expect(pathOf(unmeasured.source, unmeasured.target))
        .toBeAbsent();
      const none = yield* viewerScene(reading);
      none
        .pipe(opened(example.prd, { boxes: {}, panes }))
        .expect(paths)
        .toHaveCount(0);
    }),
);

it.effect("a curve whose end was scrolled out of its pane is dashed, and the rest are not", () =>
  Effect.gen(function* () {
    const hidden = taskKey(example.task.id);
    const scrolled: Measured = {
      boxes: Record.map(everything.boxes, (box, key) =>
        key === hidden ? UiStruct.evolve(box, { y: () => panes.stacks.y - 500 }) : box,
      ),
      panes,
    };
    const hiddenPath = pathOf(rowKey(example.spec, example.task.id), hidden);
    const shownPath = pathOf(
      rowKey(example.spec, example.neighbour.id),
      taskKey(example.neighbour.id),
    );
    const s = yield* viewerScene(reading);
    s.pipe(opened(example.prd, scrolled))
      .expect(hiddenPath)
      .toHaveAttribute("data-off-pane", "true")
      .expect(hiddenPath)
      .toHaveAttribute("style", styleDeclaring("stroke-dasharray", "5 4"))
      .expect(shownPath)
      .toHaveAttribute("data-off-pane", "false")
      .expect(shownPath)
      .toHaveAttribute("style", styleDeclaring("stroke-dasharray", "none"))
      .expect(inside(wireLayer, both(tag("path"), data("off-pane", "true"))))
      .toHaveCount(1);
  }),
);

it.effect(
  "hovering a row lights its two wires and dims the cards, rows and chips outside its chain",
  () =>
    Effect.gen(function* () {
      const inChain = chainOf(demoTrace, { id: example.task.id, kind: "task" });
      const stranger = Option.getOrThrow(
        Array.findFirst(demoTrace.tasks, (task) => !HashSet.has(inChain.tasks, task.id)),
      );
      const hoveredRow = row(example.spec, example.task.id);
      const hoveredPath = pathOf(rowKey(example.spec, example.task.id), taskKey(example.task.id));
      const s = yield* viewerScene(reading);
      s.pipe(opened(example.prd, everything))
        .fire(hoveredRow, "mouseenter")
        .expect(lit)
        .toHaveCount(2)
        .expect(pathOf(`prd:${example.prd}`, specKey(example.spec)))
        .toHaveAttribute("data-lit", "")
        .expect(hoveredPath)
        .toHaveAttribute("data-lit", "")
        .expect(hoveredPath)
        .toHaveAttribute("style", styleDeclaring("stroke-width", "2.5"))
        .expect(hoveredPath)
        .toHaveAttribute("style", styleDeclaring("stroke", "var(--ink)"))
        .expect(faint)
        .toHaveCount(Array.length(links) - 2)
        .expect(pathOf(`prd:${example.prd}`, specKey(example.other)))
        .toHaveAttribute("data-dimmed", "")
        .expect(pathOf(`prd:${example.prd}`, specKey(example.other)))
        .toHaveAttribute("style", styleDeclaring("stroke-width", "1.5"))
        .expect(specCard(example.other))
        .toHaveAttribute("data-dimmed", "")
        .expect(specCard(example.spec))
        .toHaveAttribute("data-dimmed", false)
        .expect(hoveredRow)
        .toHaveAttribute("data-dimmed", false)
        .expect(row(example.spec, example.neighbour.id))
        .toHaveAttribute("data-dimmed", "")
        .expect(chip(example.task.id))
        .toHaveAttribute("data-dimmed", false)
        .expect(chip(stranger.id))
        .toHaveAttribute("data-dimmed", "")
        .fire(hoveredRow, "mouseleave")
        .expect(lit)
        .toHaveCount(0)
        .expect(faint)
        .toHaveCount(0)
        .expect(anyDimmed)
        .toHaveCount(0)
        .expect(chip(stranger.id))
        .toHaveAttribute("data-dimmed", false);
    }),
);

it.effect("focusing a chip lights the same chain as hovering it", () =>
  Effect.gen(function* () {
    // Foldkit's focus and blur handlers test their target with `instanceof Element`, which this
    // environment has no global for; with a stand-in nothing is an Element, and they send their Message.
    yield* Effect.acquireRelease(
      Effect.sync(() => vi.stubGlobal("Element", Object)),
      () => Effect.sync(() => vi.unstubAllGlobals()),
    );
    const s = yield* viewerScene(reading);
    s.pipe(opened(example.prd, everything))
      .focus(chip(example.task.id))
      .expect(lit)
      .toHaveCount(2)
      .expect(specCard(example.other))
      .toHaveAttribute("data-dimmed", "")
      .expect(row(example.spec, example.neighbour.id))
      .toHaveAttribute("data-dimmed", "")
      .blur(chip(example.task.id))
      .expect(lit)
      .toHaveCount(0);
  }),
);

it.effect(
  "hovering a card's header lights the curve to it and the curves of the tasks it holds",
  () =>
    Effect.gen(function* () {
      const card = Option.getOrThrow(Array.head(example.cards.cards));
      const s = yield* viewerScene(reading);
      s.pipe(opened(example.prd, everything))
        .fire(header(card.section.id), "mouseenter")
        .expect(pathOf(`prd:${example.prd}`, specKey(card.section.id)))
        .toHaveAttribute("data-lit", "")
        .pipe(
          forEachStep(card.tasks, (step, task) =>
            step
              .expect(pathOf(rowKey(card.section.id, task.id), taskKey(task.id)))
              .toHaveAttribute("data-lit", ""),
          ),
        )
        .expect(pathOf(`prd:${example.prd}`, specKey(example.other)))
        .toHaveAttribute("data-dimmed", "")
        .expect(specCard(example.other))
        .toHaveAttribute("data-dimmed", "")
        .expect(specCard(card.section.id))
        .toHaveAttribute("data-dimmed", false)
        .fire(header(card.section.id), "mouseleave")
        .expect(faint)
        .toHaveCount(0);
    }),
);

// Effect UI has no test API that shows a lazy view was reused. A memoised slot (the PRD body, each
// spec card) hands back the node of the last render when its inputs are the same, so a slot was
// reused when the same node object stands in both renders, and rebuilt when it does not.
const prdBodies = (view: ViewerSteps["view"]) => nodesWithAttr(view, "class", "prd-body");
const cardNodes = (view: ViewerSteps["view"]) => nodesWithAttr(view, "data-spec");

const pinned = UiStruct.evolve(reading, {
  reader: (reader) => UiStruct.evolve(reader, { maybePinned: () => Option.some(example.prd) }),
});

/** The pinned section's reader, its mounts answered with nothing measured. */
const pinnedReader = Effect.map(viewerScene(pinned), (s) =>
  s.pipe(opened(example.prd, unmeasuredWires)),
);

it.effect("a measurement renders the wires again and nothing else", () =>
  Effect.gen(function* () {
    const s = yield* pinnedReader;
    const cardsBefore = cardNodes(s.view);
    const bodiesBefore = prdBodies(s.view);
    s.pipe(
      wiresMeasuredAs(everything),
      wiresMeasuredAs({
        boxes: Record.map(everything.boxes, (box) => UiStruct.evolve(box, { y: (y) => y + 1 })),
        panes,
      }),
    );
    assert.isAbove(Array.length(cardsBefore), 0);
    assert.lengthOf(bodiesBefore, 1);
    assert.isTrue(sameNodes(cardsBefore, cardNodes(s.view)));
    assert.isTrue(sameNodes(bodiesBefore, prdBodies(s.view)));
  }),
);

it.effect(
  "the PRD body is one lazy slot: it is rebuilt when the copied ID changes, and not by a measurement",
  () =>
    Effect.gen(function* () {
      const bare = Option.getOrThrow(
        Array.findFirst(
          demoTrace.prd.sections,
          (section) =>
            section.level > 1 &&
            Array.isReadonlyArrayEmpty(cardsOf(demoTrace, prd(section.id)).cards),
        ),
      );
      const reader = Effect.map(
        viewerScene(
          UiStruct.evolve(reading, {
            reader: (each) =>
              UiStruct.evolve(each, { maybePinned: () => Option.some(prd(bare.id)) }),
          }),
        ),
        (s) => s.pipe(opened(bare.id, unmeasuredWires)),
      );
      const measuring = yield* reader;
      const bodyBefore = prdBodies(measuring.view);
      measuring.pipe(wiresMeasuredAs(everything));
      assert.lengthOf(bodyBefore, 1);
      assert.isTrue(sameNodes(bodyBefore, prdBodies(measuring.view)));
      const copying = yield* reader;
      const bodyBeforeCopy = prdBodies(copying.view);
      copying
        .click(data("section-id", bare.id))
        .pipe(
          resolved(
            CopySectionId,
            Message.CompletedCopySectionId({ id: prd(bare.id), isCopied: true }),
          ),
        );
      assert.isFalse(sameNodes(bodyBeforeCopy, prdBodies(copying.view)));
    }),
);

it.effect("hovering rebuilds the cards, which it dims", () =>
  Effect.gen(function* () {
    const s = yield* pinnedReader;
    const cardsBefore = cardNodes(s.view);
    s.fire(chip(example.task.id), "mouseenter");
    assert.isAbove(Array.length(cardsBefore), 0);
    assert.isFalse(sameNodes(cardsBefore, cardNodes(s.view)));
  }),
);
