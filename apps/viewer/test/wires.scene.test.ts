import { PrdSectionId, type TraceTask } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, HashSet, Option, Record, String } from "effect";
import {
  Mount,
  all,
  expect,
  expectAll,
  focus,
  given,
  hover,
  scene,
  selector,
  Subscription,
} from "foldkit/scene";
import { Lazy } from "foldkit/test";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import type { Rect } from "../src/geometry.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { cardsOf, type Cards } from "../src/reader.ts";
import { chainOf } from "../src/trace.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { view } from "../src/view/view.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { linksOf, rowKey, specKey, taskKey, type Measured, type Panes } from "../src/wires.ts";
import { loaded, sequence } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });

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
const opened = (id: string, measured: Measured) =>
  [
    Mount.resolveAll(
      [TrackPrdScroll, Message.ScrolledPrd({ id: prd(id) })],
      [ScrollStacksToBottom, Message.CompletedScrollStacks()],
      [MeasureWires, Message.MeasuredWires({ measured })],
    ),
  ] as const;

/** The pointer or focus leaves a node. Scene's blur step reads DOM globals this environment lacks, so send what OnBlur sends. */
const left = Subscription.emit(Message.LeftNode());

const wireLayer = "[data-wire-layer]";
const paths = all.selector(`${wireLayer} path`);
const pathOf = (source: string, target: string) =>
  selector(`${wireLayer} path[data-wire-source="${source}"][data-wire-target="${target}"]`);
const lit = all.selector(`${wireLayer} path[data-lit]`);
const faint = all.selector(`${wireLayer} path[data-dimmed]`);
const dimmedCards = all.selector("[data-spec-pane] [data-spec][data-dimmed]");
const header = (id: string) => selector(`[data-spec="${id}"] [data-wire="${specKey(id)}"]`);
const row = (spec: string, id: string) => selector(`[data-wire="${rowKey(spec, id)}"]`);
const chip = (id: string) => selector(`[data-stacks-pane] [data-wire="${taskKey(id)}"]`);

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
  assert(Array.length(example.cards.cards)).toBeGreaterThanOrEqual(2);
  assert(Array.isReadonlyArrayNonEmpty(links)).toBe(true);
  assert(example.task.id).not.toBe(example.neighbour.id);
});

it("the elements a curve ends on carry their keys in data-wire", () => {
  const first = Option.getOrThrow(Array.head(example.cards.cards));
  scene(
    { update, view },
    given(
      modifyFields(reading, {
        reader: (reader) => modifyFields(reader, { maybePinned: () => Option.some(example.prd) }),
      }),
    ),
    ...opened(example.prd, everything),
    expect(selector(`[data-prd-pane] [data-section="${example.prd}"]`)).toHaveAttr(
      "data-wire",
      `prd:${example.prd}`,
    ),
    expect(header(first.section.id)).toExist(),
    ...Array.map(first.tasks, (task) => expect(row(first.section.id, task.id)).toExist()),
    ...Array.map(first.tasks, (task) => expect(chip(task.id)).toExist()),
    expectAll(all.selector("[data-prd-pane] [data-wire]")).toHaveCount(1),
  );
});

it("with every end measured, there is one path for each link of the section", () => {
  scene(
    { update, view },
    given(reading),
    ...opened(example.prd, everything),
    expectAll(paths).toHaveCount(Array.length(links)),
    expect(selector(wireLayer)).toHaveAttr("aria-hidden", "true"),
    expect(selector(wireLayer)).toHaveStyle("pointer-events", "none"),
    expect(selector(wireLayer)).toHaveStyle("position", "fixed"),
    ...Array.map(links, (link) => expect(pathOf(link.source, link.target)).toExist()),
    expectAll(lit).toHaveCount(0),
    expectAll(faint).toHaveCount(0),
    expectAll(dimmedCards).toHaveCount(0),
    expectAll(all.selector("[data-dimmed]")).toHaveCount(0),
  );
});

it("a link whose end is not measured has no path, and nothing is drawn before anything is measured", () => {
  const unmeasured = Option.getOrThrow(Array.head(links));
  const missing: Measured = {
    boxes: Record.remove(everything.boxes, unmeasured.target),
    panes,
  };
  scene(
    { update, view },
    given(reading),
    ...opened(example.prd, missing),
    expectAll(paths).toHaveCount(Array.length(links) - 1),
    expect(pathOf(unmeasured.source, unmeasured.target)).toBeAbsent(),
  );
  scene(
    { update, view },
    given(reading),
    ...opened(example.prd, { boxes: {}, panes }),
    expectAll(paths).toHaveCount(0),
  );
});

it("a curve whose end was scrolled out of its pane is dashed, and the rest are not", () => {
  const hidden = taskKey(example.task.id);
  const scrolled: Measured = {
    boxes: Record.map(everything.boxes, (box, key) =>
      key === hidden ? modifyFields(box, { y: () => panes.stacks.y - 500 }) : box,
    ),
    panes,
  };
  scene(
    { update, view },
    given(reading),
    ...opened(example.prd, scrolled),
    expect(pathOf(rowKey(example.spec, example.task.id), hidden)).toHaveAttr(
      "data-off-pane",
      "true",
    ),
    expect(pathOf(rowKey(example.spec, example.task.id), hidden)).toHaveStyle(
      "stroke-dasharray",
      "5 4",
    ),
    expect(
      pathOf(rowKey(example.spec, example.neighbour.id), taskKey(example.neighbour.id)),
    ).toHaveAttr("data-off-pane", "false"),
    expect(
      pathOf(rowKey(example.spec, example.neighbour.id), taskKey(example.neighbour.id)),
    ).toHaveStyle("stroke-dasharray", "none"),
    expectAll(all.selector(`${wireLayer} path[data-off-pane="true"]`)).toHaveCount(1),
  );
});

it("hovering a row lights its two wires and dims the cards, rows and chips outside its chain", () => {
  const inChain = chainOf(demoTrace, { id: example.task.id, kind: "task" });
  const stranger = Option.getOrThrow(
    Array.findFirst(demoTrace.tasks, (task) => !HashSet.has(inChain.tasks, task.id)),
  );
  scene(
    { update, view },
    given(reading),
    ...opened(example.prd, everything),
    hover(row(example.spec, example.task.id)),
    expectAll(lit).toHaveCount(2),
    expect(pathOf(`prd:${example.prd}`, specKey(example.spec))).toHaveAttr("data-lit", ""),
    expect(pathOf(rowKey(example.spec, example.task.id), taskKey(example.task.id))).toHaveAttr(
      "data-lit",
      "",
    ),
    expect(pathOf(rowKey(example.spec, example.task.id), taskKey(example.task.id))).toHaveStyle(
      "stroke-width",
      "2.5",
    ),
    expect(pathOf(rowKey(example.spec, example.task.id), taskKey(example.task.id))).toHaveStyle(
      "stroke",
      "var(--ink)",
    ),
    expectAll(faint).toHaveCount(Array.length(links) - 2),
    expect(pathOf(`prd:${example.prd}`, specKey(example.other))).toHaveAttr("data-dimmed", ""),
    expect(pathOf(`prd:${example.prd}`, specKey(example.other))).toHaveStyle("stroke-width", "1.5"),
    expect(selector(`[data-spec="${example.other}"]`)).toHaveAttr("data-dimmed", ""),
    expect(selector(`[data-spec="${example.spec}"]`)).not.toHaveAttr("data-dimmed"),
    expect(row(example.spec, example.task.id)).not.toHaveAttr("data-dimmed"),
    expect(row(example.spec, example.neighbour.id)).toHaveAttr("data-dimmed", ""),
    expect(chip(example.task.id)).not.toHaveAttr("data-dimmed"),
    expect(chip(stranger.id)).toHaveAttr("data-dimmed", ""),
    left,
    expectAll(lit).toHaveCount(0),
    expectAll(faint).toHaveCount(0),
    expectAll(all.selector("[data-dimmed]")).toHaveCount(0),
    expect(chip(stranger.id)).not.toHaveAttr("data-dimmed"),
  );
});

it("focusing a chip lights the same chain as hovering it", () => {
  scene(
    { update, view },
    given(reading),
    ...opened(example.prd, everything),
    focus(chip(example.task.id)),
    expectAll(lit).toHaveCount(2),
    expect(selector(`[data-spec="${example.other}"]`)).toHaveAttr("data-dimmed", ""),
    expect(row(example.spec, example.neighbour.id)).toHaveAttr("data-dimmed", ""),
    left,
    expectAll(lit).toHaveCount(0),
  );
});

it("hovering a card's header lights the curve to it and the curves of the tasks it holds", () => {
  const card = Option.getOrThrow(Array.head(example.cards.cards));
  scene(
    { update, view },
    given(reading),
    ...opened(example.prd, everything),
    hover(header(card.section.id)),
    expect(pathOf(`prd:${example.prd}`, specKey(card.section.id))).toHaveAttr("data-lit", ""),
    ...Array.map(card.tasks, (task) =>
      expect(pathOf(rowKey(card.section.id, task.id), taskKey(task.id))).toHaveAttr("data-lit", ""),
    ),
    expect(pathOf(`prd:${example.prd}`, specKey(example.other))).toHaveAttr("data-dimmed", ""),
    expect(selector(`[data-spec="${example.other}"]`)).toHaveAttr("data-dimmed", ""),
    expect(selector(`[data-spec="${card.section.id}"]`)).not.toHaveAttr("data-dimmed"),
    left,
    expectAll(faint).toHaveCount(0),
  );
});

it("a measurement renders the wires again and nothing else", () => {
  const pinned = modifyFields(reading, {
    reader: (reader) => modifyFields(reader, { maybePinned: () => Option.some(example.prd) }),
  });
  const measured = modifyFields(pinned, { maybeMeasuredWires: () => Option.some(everything) });
  const remeasured = modifyFields(pinned, {
    maybeMeasuredWires: () =>
      Option.some({
        boxes: Record.map(everything.boxes, (box) => modifyFields(box, { y: (y) => y + 1 })),
        panes,
      }),
  });
  assert(() =>
    Lazy.expectAllReused({ model: measured, view: sequence([measured, remeasured]) }),
  ).not.toThrow();
});

it("the PRD body is one lazy slot: it is rebuilt when the copied ID changes, and not by a measurement", () => {
  const bare = Option.getOrThrow(
    Array.findFirst(
      demoTrace.prd.sections,
      (section) =>
        section.level > 1 && Array.isReadonlyArrayEmpty(cardsOf(demoTrace, prd(section.id)).cards),
    ),
  );
  const pinned = modifyFields(reading, {
    reader: (reader) => modifyFields(reader, { maybePinned: () => Option.some(prd(bare.id)) }),
  });
  const copied = modifyFields(pinned, { maybeCopied: () => Option.some(prd(bare.id)) });
  const measured = modifyFields(pinned, { maybeMeasuredWires: () => Option.some(everything) });
  assert(() =>
    Lazy.expectAllReused({ model: pinned, view: sequence([pinned, measured]) }),
  ).not.toThrow();
  assert(() => Lazy.expectAllReused({ model: pinned, view: sequence([pinned, copied]) })).toThrow(
    "1 lazy cache miss on the second render",
  );
});

it("hovering rebuilds the cards, which it dims", () => {
  const pinned = modifyFields(reading, {
    reader: (reader) => modifyFields(reader, { maybePinned: () => Option.some(example.prd) }),
  });
  const hovered = modifyFields(pinned, {
    maybeHovered: () => Option.some({ id: example.task.id, kind: "task" as const }),
  });
  assert(() => Lazy.expectAllReused({ model: pinned, view: sequence([pinned, hovered]) })).toThrow(
    "ArgumentsChanged",
  );
});
