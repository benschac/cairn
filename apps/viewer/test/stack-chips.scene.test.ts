import { PrdSectionId, TaskId } from "@cairn/contract";
import { labelOf, stacksOf, type Stack } from "@cairn/core/stacks";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Number, Option, Record } from "effect";
import { modifyFields } from "foldkit/struct";

import { stackBoxesOf } from "../src/boxes.ts";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { FocusDetailHeading } from "../src/update.ts";
import { chipTitleOf } from "../src/view/stackChipsView.ts";
import { PressDivider } from "../src/view/dividerView.ts";
import {
  both,
  byRole,
  containing,
  data,
  forEachStep,
  inside,
  loaded,
  pushedUrl,
  readerMounted,
  resolved,
  styleDeclaring,
  tag,
  unfolded,
  viewerScene,
  withClass,
} from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const stacks = stacksOf(demoTrace.tasks);
const boxes = stackBoxesOf(demoTrace.tasks, {});
const boxOf = (stack: Stack) =>
  Option.getOrThrow(Array.findFirst(boxes, (box) => box.stack.number === stack.number));
/** Every finished trunk unfolded, for the scenes that look at a chip inside one. */
const unfoldedReading = unfolded(reading);
const stackOf = (id: string): Stack =>
  Option.getOrThrow(Array.findFirst(stacks, (stack) => Record.has(stack.cells, TaskId.make(id))));
const box = (stack: Stack) => data("stack", `${stack.number}`);
const chip = (id: string) => data("task", id);

it.effect("every stack is a box with its label for a title, holding its own chips", () =>
  Effect.gen(function* () {
    const viewer = stackOf("t52");
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .expect(byRole("region", { name: "Stacks" }))
      .toExist()
      .expect(inside(data("stacks-pane"), data("stack")))
      .toHaveCount(stacks.length)
      .pipe(
        forEachStep(stacks, (step, stack) =>
          step.expect(box(stack)).toHaveAttribute("title", labelOf(stack)),
        ),
      )
      .expect(byRole("group", { name: labelOf(viewer) }))
      .toHaveAttribute("data-stack", `${viewer.number}`)
      // Folded, the trunk t45 to t52 is the segment and has no chips; every other task has its own.
      .pipe(
        forEachStep(Record.keys(boxOf(viewer).cells), (step, id) =>
          step.expect(inside(box(viewer), chip(id))).toExist(),
        ),
        forEachStep(
          Array.filter(Record.keys(viewer.cells), (id) => !Record.has(boxOf(viewer).cells, id)),
          (step, id) => step.expect(inside(box(viewer), chip(id))).toBeAbsent(),
        ),
      )
      .expect(inside(box(viewer), chip("t45")))
      .toBeAbsent()
      .expect(inside(box(viewer), chip("t9")))
      .toBeAbsent()
      .expect(inside(box(viewer), data("stack-label")))
      .toHaveText(`${viewer.number}`)
      .expect(inside(data("stacks-pane"), data("task")))
      .toHaveCount(Array.reduce(boxes, 0, (drawn, each) => drawn + Record.size(each.cells)))
      // Unfolded, every task of the plan is a chip again.
      .click(data("segment", "t45"))
      .pipe(
        forEachStep(Record.keys(viewer.cells), (step, id) =>
          step.expect(inside(box(viewer), chip(id))).toExist(),
        ),
      );
  }),
);

it.effect("a child chip sits in the row above its parent, in the same box", () =>
  Effect.gen(function* () {
    const stack = stackOf("t6");
    assert(stack.root).toBe("t9");
    const top = Array.reduce(Record.values(stack.cells), 1, (highest, cell) =>
      Number.max(highest, cell.row),
    );
    assert(top).toBeGreaterThan(2);
    // Each chip row is two grid rows, the chips' and a gap row under them.
    const gridRowOf = (row: number) => 2 * (top - row) + 1;
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .expect(inside(box(stack), chip("t9")))
      .toHaveAttribute("style", styleDeclaring("grid-row", `${gridRowOf(1)}`))
      .expect(inside(box(stack), chip("t6")))
      .toHaveAttribute("style", styleDeclaring("grid-row", `${gridRowOf(2)}`));
  }),
);

it.effect("the levels run from the top down to the base branch bar, which is not a node", () =>
  Effect.gen(function* () {
    const top = Array.reduce(stacks, 1, (highest, stack) => Number.max(highest, stack.level));
    const waiting = stackOf("t10");
    assert(top).toBeGreaterThan(1);
    assert(waiting.level).toBeGreaterThan(stackOf("t9").level);
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .expect(inside(data("stacks"), data("level", `${top}`)))
      .toExist()
      .expect(data("level"))
      .toHaveCount(top)
      .expect(inside(data("level", `${waiting.level}`), data("stack", `${waiting.number}`)))
      .toExist()
      .expect(inside(data("level", "1"), data("stack", "1")))
      .toExist()
      .expect(inside(data("stacks-pane"), data("base-branch")))
      .toHaveText(demoTrace.baseBranch)
      .expect(withClass("base-bar"))
      .toHaveAttribute("data-base-branch", demoTrace.baseBranch)
      .expect(inside(data("base-branch"), tag("button")))
      .toBeAbsent()
      .expect(both(data("base-branch"), data("task")))
      .toBeAbsent()
      .expect(both(data("base-branch"), data("wire")))
      .toBeAbsent();
  }),
);

it.effect("a gated chip has a gate mark in its border and says what it is; the others do not", () =>
  Effect.gen(function* () {
    const gated = Array.filter(demoTrace.tasks, (task) => task.gate.required);
    const free = Array.filter(demoTrace.tasks, (task) => !task.gate.required);
    assert(Array.length(gated)).toBeGreaterThan(0);
    const t1Title = chipTitleOf(
      demoTrace,
      Option.getOrThrow(Array.findFirst(demoTrace.tasks, (task) => task.id === "t1")),
    );
    const s = yield* viewerScene(unfoldedReading);
    s.pipe(
      readerMounted,
      forEachStep(gated, (step, task) =>
        step.expect(chip(task.id)).toHaveAttribute("data-gated", ""),
      ),
      forEachStep(Array.take(free, 5), (step, task) =>
        step.expect(chip(task.id)).toHaveAttribute("data-gated", false),
      ),
    )
      .expect(chip("t1"))
      .toHaveAttribute("data-wire", "task:t1")
      .expect(chip("t1"))
      .toHaveAttribute("aria-label", t1Title)
      .expect(chip("t1"))
      .toHaveAttribute("title", t1Title);
  }),
);

it.effect(
  "a pinned section lights its chips and their boxes and dims the rest, which still click",
  () =>
    Effect.gen(function* () {
      const prd = "prd.viewer.stacks";
      const lit = Array.filter(demoTrace.tasks, (task) =>
        Array.contains(task.prdSections, PrdSectionId.make(prd)),
      );
      assert(Array.length(lit)).toBeGreaterThan(0);
      const other = Option.getOrThrow(
        Array.findFirst(
          demoTrace.tasks,
          (task) => !Array.contains(task.prdSections, PrdSectionId.make(prd)),
        ),
      );
      const first = Option.getOrThrow(Array.head(lit));
      const litBox = stackOf(first.id);
      const summary = data("stacks-summary");
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .click(data("status-line", prd))
        .pipe(pushedUrl)
        .expect(chip(first.id))
        .toHaveAttribute("data-current", "")
        .expect(chip(first.id))
        .toHaveAttribute("data-faded", false)
        .expect(box(litBox))
        .toHaveAttribute("data-current", "")
        .expect(chip(other.id))
        .toHaveAttribute("data-faded", "")
        .expect(chip(other.id))
        .toHaveAttribute("data-current", false)
        .expect(summary)
        .toHaveText(containing(`of ${stacks.length} stacks hold this section`))
        .expect(summary)
        .toHaveText(containing(`of ${demoTrace.tasks.length} tasks done`))
        .expect(summary)
        .toHaveText(containing("read up from main"))
        // A dimmed chip still takes clicks.
        .click(chip(other.id))
        .pipe(pushedUrl, resolved(FocusDetailHeading, Message.CompletedFocusDetailHeading()))
        .expectMount(PressDivider({ pane: "detail" }))
        .expect(chip(other.id))
        .toExist();
    }),
);
