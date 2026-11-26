import { TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, HashSet, Option, Record } from "effect";
import { modifyFields } from "foldkit/struct";

import { dependencyLinksOf } from "../src/arrows.ts";
import { stackBoxesOf, type Box } from "../src/boxes.ts";
import { demoTrace } from "../src/demo.ts";
import type { Rect } from "../src/geometry.ts";
import { Screen } from "../src/model.ts";
import { chainOf } from "../src/trace.ts";
import { PressDivider } from "../src/view/dividerView.ts";
import type { Measured } from "../src/wires.ts";
import {
  both,
  data,
  dividersRunning,
  focusedHeading,
  loaded,
  prdScrolledTo,
  pushedUrl,
  stacksScrolled,
  styled,
  unfolded,
  unmeasuredWires,
  viewerScene,
  wiresMeasuredAs,
  type ViewerSteps,
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

const chip = (id: string) => data("task", id);
const segment = (root: string) => data("segment", root);
const arrowOf = (kind: string) => (source: string, target: string) =>
  both(both(data("arrow", kind), data("arrow-source", source)), data("arrow-target", target));
const dependency = arrowOf("dependency");
const parent = arrowOf("parent");
const dependencies = data("arrow", "dependency");
const lit = data("lit");
const dashed = styled("stroke-dasharray", "4 3");

const opened = (s: ViewerSteps) =>
  s.pipe(dividersRunning, prdScrolledTo("prd.goal"), stacksScrolled, wiresMeasuredAs(measured));

/** The pointer leaving the chip, or focus leaving it, sends what OnMouseLeave and OnBlur send. */
const left = (id: string) => (s: ViewerSteps) => s.fire(chip(id), "mouseleave");

it.effect(
  "with Stack 24 unfolded, hovering t52 draws a dashed arrow to t68 and lights t68; leaving draws none",
  () =>
    Effect.gen(function* () {
      // t68 is outside t52's chain, so it would be dimmed, and no section is current in t68's favour.
      assert(HashSet.has(chainOf(demoTrace, { id: task("t52"), kind: "task" }).tasks, "t68")).toBe(
        false,
      );
      const s = yield* viewerScene(unfoldedReading);
      s.pipe(opened)
        .expect(dependencies)
        .toHaveCount(0)
        .expect(lit)
        .toHaveCount(0)
        .expect(chip("t68"))
        .toHaveAttribute("data-faded", "")
        .fire(chip("t52"), "mouseenter")
        .expect(dependencies)
        .toHaveCount(1)
        .expect(dependency("task:t52", "task:t68"))
        .toExist()
        .expect(both(dependency("task:t52", "task:t68"), dashed))
        .toExist()
        .expect(both(dependency("task:t52", "task:t68"), styled("stroke-width", "1.6")))
        .toExist()
        .expect(both(dependency("task:t52", "task:t68"), styled("stroke", "var(--ink)")))
        .toExist()
        .expect(both(dependency("task:t52", "task:t68"), styled("opacity", "1")))
        .toExist()
        .expect(dependency("task:t52", "task:t68"))
        .toHaveAttribute("data-dimmed", false)
        .expect(lit)
        .toHaveCount(1)
        .expect(chip("t68"))
        .toHaveAttribute("data-lit", "")
        .expect(chip("t68"))
        .toHaveAttribute("data-dimmed", false)
        .expect(chip("t68"))
        .toHaveAttribute("data-faded", false)
        // A task of the same stack that depends on t52 is not at the other end of anything.
        .expect(chip("t69"))
        .toHaveAttribute("data-lit", false)
        .expect(chip("t69"))
        .toHaveAttribute("data-dimmed", "")
        .pipe(left("t52"))
        .expect(dependencies)
        .toHaveCount(0)
        .expect(lit)
        .toHaveCount(0)
        .expect(chip("t68"))
        .toHaveAttribute("data-faded", "");
    }),
);

it.effect(
  "with the trunk folded, hovering t68 draws its arrows from the segments and lights them",
  () =>
    Effect.gen(function* () {
      const trunk = rootOf("t52");
      const other = rootOf("t39");
      assert(trunk).toBe("t45");
      const s = yield* viewerScene(reading);
      s.pipe(opened)
        .expect(chip("t52"))
        .toBeAbsent()
        .expect(segment(trunk))
        .toHaveAttribute("data-faded", "")
        .fire(chip("t68"), "mouseenter")
        .expect(dependencies)
        .toHaveCount(3)
        .expect(dependency("segment:t45", "task:t68"))
        .toExist()
        .expect(both(dependency("segment:t45", "task:t68"), dashed))
        .toExist()
        .expect(dependency(`segment:${other}`, "task:t68"))
        .toExist()
        .expect(dependency("task:t68", "task:t216"))
        .toExist()
        .expect(segment(trunk))
        .toHaveAttribute("data-lit", "")
        .expect(segment(trunk))
        .toHaveAttribute("data-dimmed", false)
        .expect(segment(trunk))
        .toHaveAttribute("data-faded", false)
        .expect(segment(other))
        .toHaveAttribute("data-lit", "")
        .expect(chip("t216"))
        .toHaveAttribute("data-lit", "")
        .expect(chip("t68"))
        .toHaveAttribute("data-lit", false)
        .pipe(left("t68"))
        .expect(dependencies)
        .toHaveCount(0)
        .expect(segment(trunk))
        .toHaveAttribute("data-lit", false)
        .expect(segment(trunk))
        .toHaveAttribute("data-faded", "");
    }),
);

it.effect(
  "a parent arrow into a lit chip is not dimmed with the rest while another chain is hovered",
  () =>
    Effect.gen(function* () {
      // t81 is built on t54 and t216 depends on it. t81 is outside t216's chain.
      assert(HashSet.has(chainOf(demoTrace, { id: task("t216"), kind: "task" }).tasks, "t81")).toBe(
        false,
      );
      const s = yield* viewerScene(unfoldedReading);
      s.pipe(opened)
        .fire(chip("t216"), "mouseenter")
        .expect(chip("t81"))
        .toHaveAttribute("data-lit", "")
        .expect(parent("task:t54", "fork:t81"))
        .toHaveAttribute("data-dimmed", false)
        .expect(both(parent("task:t54", "fork:t81"), styled("opacity", "0.55")))
        .toExist()
        .expect(parent("task:t54", "fork:t67"))
        .toHaveAttribute("data-dimmed", "");
    }),
);

/** Clicking a chip opens the panel on its task and moves focus to its heading; t68 has no commits to fetch. */
const opening = (id: string) => (s: ViewerSteps) =>
  s
    .click(chip(id))
    .pipe(pushedUrl, focusedHeading)
    .expectMount(PressDivider({ pane: "detail" }));

it.effect(
  "opening t68 in the detail panel with nothing hovered draws the same arrows, and closing it clears them",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(opened)
        .expect(dependencies)
        .toHaveCount(0)
        .pipe(opening("t68"))
        .expect(dependencies)
        .toHaveCount(3)
        .expect(dependency("segment:t45", "task:t68"))
        .toExist()
        .expect(dependency("task:t68", "task:t216"))
        .toExist()
        .expect(segment("t45"))
        .toHaveAttribute("data-lit", "")
        .expect(chip("t216"))
        .toHaveAttribute("data-lit", "")
        .click(data("detail-close"))
        .pipe(pushedUrl)
        .expect(dependencies)
        .toHaveCount(0)
        .expect(lit)
        .toHaveCount(0);
    }),
);

it.effect(
  "a hovered task is the focus over the open one, and leaving it falls back to the open one",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(unfoldedReading);
      s.pipe(opened, opening("t68"))
        .expect(dependencies)
        .toHaveCount(3)
        .fire(chip("t52"), "mouseenter")
        .expect(dependencies)
        .toHaveCount(1)
        .expect(dependency("task:t52", "task:t68"))
        .toExist()
        .pipe(left("t52"))
        .expect(dependencies)
        .toHaveCount(3)
        .expect(dependency("task:t68", "task:t216"))
        .toExist();
    }),
);

it.effect(
  "focusing the chip of t68 from the keyboard draws the arrows, and blurring it clears them",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(opened)
        .focus(chip("t68"))
        .expect(dependencies)
        .toHaveCount(3)
        .expect(dependency("segment:t45", "task:t68"))
        .toExist()
        .expect(segment("t45"))
        .toHaveAttribute("data-lit", "")
        // OnBlur's handler reads the DOM's Element, which this test environment lacks: the chip's
        // mouseleave sends the same Message.
        .pipe(left("t68"))
        .expect(dependencies)
        .toHaveCount(0)
        .expect(lit)
        .toHaveCount(0);
    }),
);

it.effect("a task with no dependency in another stack draws no arrow when it is in focus", () =>
  Effect.gen(function* () {
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
    const s = yield* viewerScene(reading);
    s.pipe(opened)
      .expect(chip(alone.id))
      .toExist()
      .fire(chip(alone.id), "mouseenter")
      .expect(dependencies)
      .toHaveCount(0)
      .expect(lit)
      .toHaveCount(0);
  }),
);
