import { PrdSectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, HashSet, Option, Record } from "effect";
import {
  Mount,
  Subscription,
  all,
  click,
  expect,
  expectAll,
  focus,
  given,
  hover,
  scene,
  selector,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { dependencyLinksOf } from "../src/arrows.ts";
import { stackBoxesOf, type Box } from "../src/boxes.ts";
import { demoTrace } from "../src/demo.ts";
import type { Rect } from "../src/geometry.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { chainOf } from "../src/trace.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { view } from "../src/view/view.ts";
import type { Measured } from "../src/wires.ts";
import {
  focusedDetailHeading,
  loaded,
  unfolded,
  unmeasuredWires,
  wiresMountedWith,
} from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const unfoldedReading = unfolded(reading);
const foldedBoxes = stackBoxesOf(demoTrace.tasks, {});

const task = (id: string) => TaskId.make(id);
const boxWith = (boxes: ReadonlyArray<Box>, id: string): Box =>
  Option.getOrThrow(Array.findFirst(boxes, (box) => Record.has(box.stack.cells, task(id))));
const rootOf = (id: string): string => boxWith(foldedBoxes, id).stack.root;

/**
 * Every key a chip, fork label or segment of the demo trace is drawn with, one under the other in
 * the list, which is at the origin. A key a view does not draw is measured and never used.
 */
const measured: Measured = {
  boxes: Record.fromEntries(
    Array.prepend(
      Array.map(
        Array.dedupe(
          Array.flatten([
            Array.map(demoTrace.tasks, (each) => `task:${each.id}`),
            Array.map(foldedBoxes, (box) => `segment:${box.stack.root}`),
            Array.flatMap(foldedBoxes, (box) =>
              Array.flatMap(box.arrows, (link) => [link.source, link.target]),
            ),
          ]),
        ),
        (key, index) =>
          [
            key,
            { height: 20, width: 60, x: 920, y: 100 + index * 40 },
          ] as const satisfies readonly [string, Rect],
      ),
      ["stacks:list", { height: 12000, width: 280, x: 910, y: 60 }] as const,
    ),
  ),
  panes: unmeasuredWires.panes,
};

const opened = [
  Mount.resolve(TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })),
  Mount.resolve(
    ScrollStacksToBottom,
    Message.CompletedScrollStacks({ maybeChartWidth: Option.none() }),
  ),
  wiresMountedWith(measured),
] as const;

const left = Subscription.emit(Message.LeftNode());

const chip = (id: string) => selector(`[data-task="${id}"]`);
const segment = (root: string) => selector(`[data-segment="${root}"]`);
const dependency = (source: string, target: string) =>
  selector(
    `[data-arrow="dependency"][data-arrow-source="${source}"][data-arrow-target="${target}"]`,
  );
const parent = (source: string, target: string) =>
  selector(`[data-arrow="parent"][data-arrow-source="${source}"][data-arrow-target="${target}"]`);
const dependencies = all.selector('[data-arrow="dependency"]');
const lit = all.selector("[data-lit]");

it("with Stack 24 unfolded, hovering t52 draws a dashed arrow to t68 and lights t68; leaving draws none", () => {
  // t68 is outside t52's chain, so it would be dimmed, and no section is current in t68's favour.
  assert(HashSet.has(chainOf(demoTrace, { id: task("t52"), kind: "task" }).tasks, "t68")).toBe(
    false,
  );
  scene(
    { update, view },
    given(unfoldedReading),
    ...opened,
    expectAll(dependencies).toHaveCount(0),
    expectAll(lit).toHaveCount(0),
    expect(chip("t68")).toHaveAttr("data-faded", ""),
    hover(chip("t52")),
    expectAll(dependencies).toHaveCount(1),
    expect(dependency("task:t52", "task:t68")).toExist(),
    expect(dependency("task:t52", "task:t68")).toHaveStyle("stroke-dasharray", "4 3"),
    expect(dependency("task:t52", "task:t68")).toHaveStyle("stroke-width", "1.6"),
    expect(dependency("task:t52", "task:t68")).toHaveStyle("stroke", "var(--ink)"),
    expect(dependency("task:t52", "task:t68")).toHaveStyle("opacity", "1"),
    expect(dependency("task:t52", "task:t68")).not.toHaveAttr("data-dimmed"),
    expectAll(lit).toHaveCount(1),
    expect(chip("t68")).toHaveAttr("data-lit", ""),
    expect(chip("t68")).not.toHaveAttr("data-dimmed"),
    expect(chip("t68")).not.toHaveAttr("data-faded"),
    // A task of the same stack that depends on t52 is not at the other end of anything.
    expect(chip("t69")).not.toHaveAttr("data-lit"),
    expect(chip("t69")).toHaveAttr("data-dimmed", ""),
    left,
    expectAll(dependencies).toHaveCount(0),
    expectAll(lit).toHaveCount(0),
    expect(chip("t68")).toHaveAttr("data-faded", ""),
  );
});

it("with the trunk folded, hovering t68 draws its arrows from the segments and lights them", () => {
  const trunk = rootOf("t52");
  const other = rootOf("t39");
  assert(trunk).toBe("t45");
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(chip("t52")).toBeAbsent(),
    expect(segment(trunk)).toHaveAttr("data-faded", ""),
    hover(chip("t68")),
    expectAll(dependencies).toHaveCount(3),
    expect(dependency("segment:t45", "task:t68")).toExist(),
    expect(dependency("segment:t45", "task:t68")).toHaveStyle("stroke-dasharray", "4 3"),
    expect(dependency(`segment:${other}`, "task:t68")).toExist(),
    expect(dependency("task:t68", "task:t216")).toExist(),
    expect(segment(trunk)).toHaveAttr("data-lit", ""),
    expect(segment(trunk)).not.toHaveAttr("data-dimmed"),
    expect(segment(trunk)).not.toHaveAttr("data-faded"),
    expect(segment(other)).toHaveAttr("data-lit", ""),
    expect(chip("t216")).toHaveAttr("data-lit", ""),
    expect(chip("t68")).not.toHaveAttr("data-lit"),
    left,
    expectAll(dependencies).toHaveCount(0),
    expect(segment(trunk)).not.toHaveAttr("data-lit"),
    expect(segment(trunk)).toHaveAttr("data-faded", ""),
  );
});

it("a parent arrow into a lit chip is not dimmed with the rest while another chain is hovered", () => {
  // t81 is built on t54 and t216 depends on it. t81 is outside t216's chain.
  assert(HashSet.has(chainOf(demoTrace, { id: task("t216"), kind: "task" }).tasks, "t81")).toBe(
    false,
  );
  scene(
    { update, view },
    given(unfoldedReading),
    ...opened,
    hover(chip("t216")),
    expect(chip("t81")).toHaveAttr("data-lit", ""),
    expect(parent("task:t54", "fork:t81")).not.toHaveAttr("data-dimmed"),
    expect(parent("task:t54", "fork:t81")).toHaveStyle("opacity", "0.55"),
    expect(parent("task:t54", "fork:t67")).toHaveAttr("data-dimmed", ""),
  );
});

/** Clicking a chip opens the panel on its task and moves focus to its heading; t68 has no commits to fetch. */
const opening = (id: string) => [click(chip(id)), focusedDetailHeading] as const;

it("opening t68 in the detail panel with nothing hovered draws the same arrows, and closing it clears them", () => {
  scene(
    { update, view },
    given(reading),
    ...opened,
    expectAll(dependencies).toHaveCount(0),
    ...opening("t68"),
    expectAll(dependencies).toHaveCount(3),
    expect(dependency("segment:t45", "task:t68")).toExist(),
    expect(dependency("task:t68", "task:t216")).toExist(),
    expect(segment("t45")).toHaveAttr("data-lit", ""),
    expect(chip("t216")).toHaveAttr("data-lit", ""),
    click(selector("[data-detail-close]")),
    expectAll(dependencies).toHaveCount(0),
    expectAll(lit).toHaveCount(0),
  );
});

it("a hovered task is the focus over the open one, and leaving it falls back to the open one", () => {
  scene(
    { update, view },
    given(unfoldedReading),
    ...opened,
    ...opening("t68"),
    expectAll(dependencies).toHaveCount(3),
    hover(chip("t52")),
    expectAll(dependencies).toHaveCount(1),
    expect(dependency("task:t52", "task:t68")).toExist(),
    left,
    expectAll(dependencies).toHaveCount(3),
    expect(dependency("task:t68", "task:t216")).toExist(),
  );
});

it("focusing the chip of t68 from the keyboard draws the arrows, and blurring it clears them", () => {
  scene(
    { update, view },
    given(reading),
    ...opened,
    focus(chip("t68")),
    expectAll(dependencies).toHaveCount(3),
    expect(dependency("segment:t45", "task:t68")).toExist(),
    expect(segment("t45")).toHaveAttr("data-lit", ""),
    // Scene's blur step reads DOM globals this test environment lacks, so send what OnBlur sends.
    left,
    expectAll(dependencies).toHaveCount(0),
    expectAll(lit).toHaveCount(0),
  );
});

it("a task with no dependency in another stack draws no arrow when it is in focus", () => {
  const alone = Option.getOrThrow(
    Array.findFirst(
      demoTrace.tasks,
      (each) =>
        Record.has(boxWith(foldedBoxes, each.id).cells, each.id) &&
        Array.isReadonlyArrayEmpty(
          dependencyLinksOf(demoTrace, foldedBoxes, Option.some(each.id)).links,
        ),
    ),
  );
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(chip(alone.id)).toExist(),
    hover(chip(alone.id)),
    expectAll(dependencies).toHaveCount(0),
    expectAll(lit).toHaveCount(0),
  );
});
