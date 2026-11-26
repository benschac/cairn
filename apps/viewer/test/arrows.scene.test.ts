import { UiStruct } from "@effect/ui";
import { TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Record } from "effect";

import { stackBoxesOf, type Box } from "../src/boxes.ts";
import { demoTrace } from "../src/demo.ts";
import type { Rect } from "../src/geometry.ts";
import { Screen } from "../src/model.ts";
import type { Measured } from "../src/wires.ts";
import {
  both,
  data,
  dividersRunning,
  loaded,
  prdScrolledTo,
  stacksScrolled,
  styled,
  unfolded,
  unmeasuredWires,
  viewerScene,
  wiresMeasuredAs,
  type ViewerSteps,
} from "./fixtures.ts";

const reading = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });
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

const opened = (measured: Measured) => (s: ViewerSteps) =>
  s.pipe(dividersRunning, prdScrolledTo("prd.goal"), stacksScrolled, wiresMeasuredAs(measured));

const arrow = (source: string, target: string) =>
  both(both(data("arrow", "parent"), data("arrow-source", source)), data("arrow-target", target));

it.effect("the stacks list is the origin the arrows are drawn from", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(opened(unmeasuredWires))
      .expect(data("stacks"))
      .toHaveAttribute("data-wire", "stacks:list")
      .expect(data("arrow-layer"))
      .toHaveAttribute("aria-hidden", "true")
      .expect(data("arrow"))
      .toHaveCount(0);
  }),
);

it.effect(
  "Stack 24, folded, has an arrow from its segment to each fork label and one into every other chip",
  () =>
    Effect.gen(function* () {
      const box = viewerOf(foldedBoxes);
      assert(Array.length(box.arrows)).toBeGreaterThan(5);
      const s = yield* viewerScene(reading);
      const withForks = Array.reduce(
        ["t69", "t71", "t75"],
        s.pipe(opened(measuredFor(foldedBoxes))),
        (steps, id) => steps.expect(arrow("segment:t45", `fork:${id}`)).toExist(),
      );
      Array.reduce(box.arrows, withForks, (steps, link) =>
        steps.expect(arrow(link.source, link.target)).toExist(),
      )
        .expect(data("arrow"))
        .toHaveCount(Array.length(Array.flatMap(foldedBoxes, (each) => each.arrows)))
        .expect(data("arrow", "dependency"))
        .toHaveCount(0)
        .expect(arrow("task:t45", "task:t46"))
        .toBeAbsent();
    }),
);

it.effect("Stack 24, unfolded, has an arrow from t45 to t46", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(unfoldedReading);
    s.pipe(opened(measuredFor(unfoldedBoxes)))
      .expect(arrow("task:t45", "task:t46"))
      .toExist()
      .expect(arrow("task:t45", "task:t46"))
      .toHaveAttribute("data-arrow", "parent")
      .expect(data("arrow"))
      .toHaveCount(Array.length(Array.flatMap(unfoldedBoxes, (each) => each.arrows)));
  }),
);

it.effect("an arrow is dimmed with its child's chip while another chain is hovered", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(unfoldedReading);
    s.pipe(opened(measuredFor(unfoldedBoxes)))
      .expect(both(arrow("task:t45", "task:t46"), styled("opacity", "0.55")))
      .toExist()
      .fire(data("task", "t1"), "mouseenter")
      .expect(arrow("task:t45", "task:t46"))
      .toHaveAttribute("data-dimmed", "")
      .expect(both(arrow("task:t45", "task:t46"), styled("opacity", "0.15")))
      .toExist();
  }),
);
