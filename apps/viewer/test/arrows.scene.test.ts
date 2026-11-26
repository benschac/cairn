import { PrdSectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Record } from "effect";
import { Mount, all, expect, expectAll, given, hover, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { stackBoxesOf, type Box } from "../src/boxes.ts";
import { demoTrace } from "../src/demo.ts";
import type { Rect } from "../src/geometry.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { view } from "../src/view/view.ts";
import type { Measured } from "../src/wires.ts";
import { loaded, unfolded, unmeasuredWires, wiresMounted, wiresMountedWith } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const unfoldedReading = unfolded(reading);
const foldedBoxes = stackBoxesOf(demoTrace.tasks, {});
const unfoldedBoxes = stackBoxesOf(demoTrace.tasks, unfoldedReading.reader.unfolded);
const viewerOf = (boxes: ReadonlyArray<Box>): Box =>
  Option.getOrThrow(Array.findFirst(boxes, (box) => Record.has(box.cells, TaskId.make("t69"))));

/** Every key an arrow of these boxes names, one under the other in the list, which is at the origin. */
const measuredFor = (boxes: ReadonlyArray<Box>): Measured => {
  const keys = Array.dedupe(
    Array.flatMap(boxes, (box) => Array.flatMap(box.arrows, (link) => [link.source, link.target])),
  );
  return {
    boxes: Record.fromEntries(
      Array.prepend(
        Array.map(
          keys,
          (key, index) =>
            [
              key,
              { height: 20, width: 60, x: 920, y: 100 + index * 40 },
            ] as const satisfies readonly [string, Rect],
        ),
        ["stacks:list", { height: 4000, width: 280, x: 910, y: 60 }] as const,
      ),
    ),
    panes: unmeasuredWires.panes,
  };
};

const opened = (wires: ReturnType<typeof wiresMountedWith>) =>
  [
    Mount.resolve(TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })),
    Mount.resolve(
      ScrollStacksToBottom,
      Message.CompletedScrollStacks({ maybeChartWidth: Option.none() }),
    ),
    wires,
  ] as const;

const arrow = (source: string, target: string) =>
  selector(`[data-arrow="parent"][data-arrow-source="${source}"][data-arrow-target="${target}"]`);

it("the stacks list is the origin the arrows are drawn from", () => {
  scene(
    { update, view },
    given(reading),
    ...opened(wiresMounted),
    expect(selector("[data-stacks]")).toHaveAttr("data-wire", "stacks:list"),
    expect(selector("[data-arrow-layer]")).toHaveAttr("aria-hidden", "true"),
    expectAll(all.selector("[data-arrow]")).toHaveCount(0),
  );
});

it("Stack 24, folded, has an arrow from its segment to each fork label and one into every other chip", () => {
  const box = viewerOf(foldedBoxes);
  assert(Array.length(box.arrows)).toBeGreaterThan(5);
  scene(
    { update, view },
    given(reading),
    ...opened(wiresMountedWith(measuredFor(foldedBoxes))),
    ...Array.map(["t69", "t71", "t75"], (id) =>
      expect(arrow("segment:t45", `fork:${id}`)).toExist(),
    ),
    ...Array.map(box.arrows, (link) => expect(arrow(link.source, link.target)).toExist()),
    expectAll(all.selector("[data-arrow]")).toHaveCount(
      Array.length(Array.flatMap(foldedBoxes, (each) => each.arrows)),
    ),
    expectAll(all.selector('[data-arrow="dependency"]')).toHaveCount(0),
    expect(arrow("task:t45", "task:t46")).toBeAbsent(),
  );
});

it("Stack 24, unfolded, has an arrow from t45 to t46", () => {
  scene(
    { update, view },
    given(unfoldedReading),
    ...opened(wiresMountedWith(measuredFor(unfoldedBoxes))),
    expect(arrow("task:t45", "task:t46")).toExist(),
    expect(arrow("task:t45", "task:t46")).toHaveAttr("data-arrow", "parent"),
    expectAll(all.selector("[data-arrow]")).toHaveCount(
      Array.length(Array.flatMap(unfoldedBoxes, (each) => each.arrows)),
    ),
  );
});

it("an arrow is dimmed with its child's chip while another chain is hovered", () => {
  scene(
    { update, view },
    given(unfoldedReading),
    ...opened(wiresMountedWith(measuredFor(unfoldedBoxes))),
    expect(arrow("task:t45", "task:t46")).toHaveStyle("opacity", "0.55"),
    hover(selector('[data-task="t1"]')),
    expect(arrow("task:t45", "task:t46")).toHaveAttr("data-dimmed", ""),
    expect(arrow("task:t45", "task:t46")).toHaveStyle("opacity", "0.15"),
  );
});
