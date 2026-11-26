import { PrdSectionId, TaskId } from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, HashSet, Option, Record, Result, Schema } from "effect";
import { modifyFields } from "foldkit/struct";

import { patchPathOf } from "../src/codeView.ts";
import { FetchPatch } from "../src/command.ts";
import { stackBoxesOf } from "../src/boxes.ts";
import { RenderDiff } from "../src/diff.ts";
import { demoTrace } from "../src/demo.ts";
import { linkOf, linkTargetsOf } from "../src/links.ts";
import { Message } from "../src/message.ts";
import { Screen, WHOLE_TASK } from "../src/model.ts";
import { cardsOf, currentTasksOf, stackTaskSelectorOf } from "../src/reader.ts";
import { chainOf } from "../src/trace.ts";
import { FocusDetailHeading, update } from "../src/update.ts";
import { PressDivider } from "../src/view/dividerView.ts";
import { rowKey, segmentKey, type Measured } from "../src/wires.ts";
import {
  both,
  data,
  dividersRunning,
  forEachStep,
  inside,
  loaded,
  prdScrolledTo,
  pushedUrl,
  readerMounted,
  resolved,
  stacksScrolled,
  styleDeclaring,
  tag,
  viewerScene,
  type ViewerSteps,
  wiresMeasuredAs,
} from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const boxes = stackBoxesOf(demoTrace.tasks, {});
const boxWith = (id: string) =>
  Option.getOrThrow(Array.findFirst(boxes, (box) => Record.has(box.stack.cells, TaskId.make(id))));
const viewer = boxWith("t52");
const trunk = Option.getOrThrow(viewer.maybeTrunk);
const root = trunk.root;

const stack = (box: typeof viewer) => data("stack", `${box.stack.number}`);
const chip = (id: string) => data("task", id);
const inViewer = (id: string) => inside(stack(viewer), chip(id));
const segment = (id: string) => data("segment", id);
const forkLabel = (id: string) => both(data("fork-label"), data("wire", `fork:${id}`));
const wiresAttribute = data("wires");

/** The reader's mounts, with the wires measured as given. */
const openedWith = (measured: Measured) => (s: ViewerSteps) =>
  s.pipe(dividersRunning, prdScrolledTo("prd.goal"), stacksScrolled, wiresMeasuredAs(measured));
const opened = readerMounted;

const gridRowOf = (rows: number, row: number): number => 2 * (rows - row) + 1;

it.effect("Stack 24 is one segment under its branches, and the branches are labelled", () =>
  Effect.gen(function* () {
    assert(trunk.tasks).toEqual(Array.makeBy(8, (index) => TaskId.make(`t${45 + index}`)));
    const s = yield* viewerScene(reading);
    s.pipe(opened)
      .expect(inside(stack(viewer), segment(root)))
      .toHaveText("t45–t52 · viewer · 8 done")
      .expect(data("segment"))
      .toHaveCount(Array.length(Array.filter(boxes, (box) => Option.isSome(box.maybeTrunk))))
      .expect(segment(root))
      .toHaveAttribute("data-holds", Array.join(trunk.tasks, " "))
      .expect(segment(root))
      .toHaveAttribute("data-wire", "segment:t45")
      .expect(segment(root))
      .toHaveAttribute("aria-expanded", "false")
      .expect(segment(root))
      .toHaveAttribute("title", "t45–t52 · viewer · 8 done · click to unfold")
      .expect(segment(root))
      .toHaveAttribute("aria-label", "t45–t52 · viewer · 8 done · click to unfold")
      .pipe(forEachStep(trunk.tasks, (step, id) => step.expect(inViewer(id)).toBeAbsent()))
      // Row 1 stands on the segment, and each child of the fork is labelled at its foot.
      .pipe(
        forEachStep(
          [
            ["t69", "stacks"],
            ["t71", "fuzzy-matching"],
            ["t75", "code-view"],
            ["t67", "server"],
            ["t81", "demo-data"],
          ] as const,
          (step, [id, label]) => step.expect(forkLabel(id)).toHaveText(label),
        ),
        forEachStep(["t69", "t71", "t75"], (step, id) =>
          step
            .expect(inViewer(id))
            .toHaveAttribute("style", styleDeclaring("grid-row", `${gridRowOf(viewer.rows, 1)}`)),
        ),
        forEachStep(["t69", "t71", "t75"], (step, id) =>
          step
            .expect(forkLabel(id))
            .toHaveAttribute(
              "style",
              styleDeclaring("grid-row", `${gridRowOf(viewer.rows, 1) + 1}`),
            ),
        ),
      )
      .expect(forkLabel("t69"))
      .toHaveAttribute("data-wire", "fork:t69");
  }),
);

it.effect("a chip is centred across the columns of everything built on it", () =>
  Effect.gen(function* () {
    const spans = Array.filter(Record.toEntries(viewer.cells), ([, cell]) => cell.span > 1);
    assert(Array.isReadonlyArrayNonEmpty(spans)).toBe(true);
    const s = yield* viewerScene(reading);
    s.pipe(
      opened,
      forEachStep(spans, (step, [id, cell]) =>
        step
          .expect(inViewer(id))
          .toHaveAttribute(
            "style",
            styleDeclaring("grid-column", `${cell.column} / span ${cell.span}`),
          ),
      ),
      forEachStep(spans, (step, [id, cell]) =>
        step
          .expect(inViewer(id))
          .toHaveAttribute(
            "style",
            styleDeclaring("grid-row", `${gridRowOf(viewer.rows, cell.row)}`),
          ),
      ),
    );
  }),
);

it.effect(
  "clicking the segment shows the eight chips and Fold t45–t52, and clicking that folds the trunk again",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(opened)
        .click(segment(root))
        .pipe(forEachStep(trunk.tasks, (step, id) => step.expect(inViewer(id)).toExist()))
        .expect(segment(root))
        .toHaveText("Fold t45–t52")
        .expect(segment(root))
        .toHaveAttribute("aria-expanded", "true")
        .expect(segment(root))
        .toHaveAttribute("data-holds", Array.join(trunk.tasks, " "))
        .expect(segment(root))
        .toHaveAttribute("data-wire", "segment:t45")
        // Unfolded, the chips keep the rows stacksOf gave them: the box is four rows taller.
        .expect(inViewer("t45"))
        .toHaveAttribute(
          "style",
          styleDeclaring("grid-row", `${gridRowOf(viewer.rows + Array.length(trunk.tasks), 1)}`),
        )
        .click(segment(root))
        .pipe(forEachStep(trunk.tasks, (step, id) => step.expect(inViewer(id)).toBeAbsent()))
        .expect(segment(root))
        .toHaveText("t45–t52 · viewer · 8 done")
        .expect(segment(root))
        .toHaveAttribute("aria-expanded", "false");
    }),
);

it.effect("unfolding one trunk leaves the others folded, and the body is measured again", () =>
  Effect.gen(function* () {
    const other = Option.getOrThrow(
      Array.findFirst(boxes, (box) => Option.isSome(box.maybeTrunk) && box.stack.root !== root),
    );
    assert(other.stack.root).not.toBe(root);
    const s = yield* viewerScene(reading);
    s.pipe(opened)
      .expect(wiresAttribute)
      .toHaveAttribute("data-wires", "prd.goal|models")
      .click(segment(root))
      .expect(wiresAttribute)
      .toHaveAttribute("data-wires", "prd.goal|models|t45")
      .expect(segment(other.stack.root))
      .toHaveAttribute("aria-expanded", "false")
      .click(segment(root))
      .expect(wiresAttribute)
      .toHaveAttribute("data-wires", "prd.goal|models");
  }),
);

it.effect("a box whose trunk is one task, or that has no trunk, has no segment", () =>
  Effect.gen(function* () {
    const lone = Option.getOrThrow(
      Array.findFirst(
        boxes,
        (box) => Option.isNone(box.maybeTrunk) && Record.has(box.cells, box.stack.root),
      ),
    );
    assert(Array.length(stacksOf(demoTrace.tasks))).toBeGreaterThan(1);
    const s = yield* viewerScene(reading);
    s.pipe(opened)
      .expect(inside(stack(lone), chip(lone.stack.root)))
      .toExist()
      .expect(inside(stack(lone), data("segment")))
      .toBeAbsent()
      .expect(inside(stack(lone), data("fork-label")))
      .toBeAbsent();
  }),
);

/** A PRD section and a spec row inside the trunk's tasks that its cards list. */
const rowInTrunk = Option.getOrThrow(
  Array.findFirst(
    Array.flatMap(demoTrace.prd.sections, (section) => {
      const prd = PrdSectionId.make(section.id);
      return Array.flatMap(cardsOf(demoTrace, prd).cards, (card) =>
        Array.map(
          Array.filter(card.tasks, (task) => Array.contains(trunk.tasks, task.id)),
          (task) => ({ prd, spec: card.section.id, task: task.id }),
        ),
      );
    }),
    () => true,
  ),
);

it.effect(
  "a pinned section with a task inside the folded trunk marks the segment current, and the others faded",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(opened)
        // The section at the top of the PRD is current to begin with, and holds none of the trunk.
        .expect(segment(root))
        .toHaveAttribute("data-current", false)
        .expect(segment(root))
        .toHaveAttribute("data-faded", "")
        .click(data("status-line", rowInTrunk.prd))
        .pipe(pushedUrl)
        .expect(segment(root))
        .toHaveAttribute("data-current", "")
        .expect(segment(root))
        .toHaveAttribute("data-faded", false)
        .expect(stack(viewer))
        .toHaveAttribute("data-current", "")
        .expect(segment(elsewhere.stack.root))
        .toHaveAttribute("data-faded", "")
        .expect(segment(elsewhere.stack.root))
        .toHaveAttribute("data-current", false)
        // Unfolded, the chips carry the marks and the bar does not.
        .click(segment(root))
        .expect(segment(root))
        .toHaveAttribute("data-current", false)
        .expect(inViewer(rowInTrunk.task))
        .toHaveAttribute("data-current", "");
    }),
);

/** A box with a finished trunk whose tasks are in neither the pinned section's chain nor the row's. */
const elsewhere = Option.getOrThrow(
  Array.findFirst(boxes, (box) =>
    Option.exists(
      box.maybeTrunk,
      (other) =>
        box.stack.root !== root &&
        !Array.some(
          other.tasks,
          (id) =>
            HashSet.has(currentTasksOf(demoTrace, Option.some(rowInTrunk.prd)), id) ||
            HashSet.has(chainOf(demoTrace, { id: rowInTrunk.task, kind: "task" }).tasks, id),
        ),
    ),
  ),
);

/** The row of a task in the card of the section its trunk task is listed in. */
const rowOf = (id: string) => data("task-row", `${rowInTrunk.spec}:${id}`);
const pinnedOnTrunk = (s: ViewerSteps) =>
  s.click(data("status-line", rowInTrunk.prd)).pipe(pushedUrl);

it.effect("opening a task inside the folded trunk selects the segment", () =>
  Effect.gen(function* () {
    const task = Option.getOrThrow(
      Array.findFirst(demoTrace.tasks, (each) => each.id === rowInTrunk.task),
    );
    const s = yield* viewerScene(reading);
    s.pipe(opened, pinnedOnTrunk)
      .expect(segment(root))
      .toHaveAttribute("data-selected", false)
      .click(rowOf(rowInTrunk.task))
      .pipe(pushedUrl, resolved(FocusDetailHeading, Message.CompletedFocusDetailHeading()))
      .expectMount(PressDivider({ pane: "detail" }))
      .pipe(
        forEachStep(Option.toArray(patchPathOf(task, WHOLE_TASK)), (step, path) =>
          step
            .pipe(resolved(FetchPatch, Message.ReceivedPatch({ path, result: Result.succeed("") })))
            .mounted(RenderDiff, Message.CompletedRenderDiff()),
        ),
      )
      .expect(segment(root))
      .toHaveAttribute("data-selected", "")
      // A task elsewhere in the card is not in the trunk, and no other segment is selected.
      .expect(both(data("segment"), data("selected")))
      .toHaveCount(1);
  }),
);

/** Whether the chain of a task holds a task of the finished trunk. */
const holdsTrunk = (id: string) =>
  Array.some(
    Array.fromIterable(chainOf(demoTrace, { id: TaskId.make(id), kind: "task" }).tasks),
    (task) => Array.contains(trunk.tasks, TaskId.make(task)),
  );

it.effect(
  "hovering a node outside the trunk's chain dims the segment, and one inside it does not",
  () =>
    Effect.gen(function* () {
      const outside = Option.getOrThrow(
        Array.findFirst(
          demoTrace.tasks,
          (task) => Record.has(boxWith(task.id).cells, task.id) && !holdsTrunk(task.id),
        ),
      );
      const s = yield* viewerScene(reading);
      s.pipe(opened, pinnedOnTrunk)
        .expect(segment(root))
        .toHaveAttribute("data-dimmed", false)
        .fire(chip(outside.id), "mouseenter")
        .expect(segment(root))
        .toHaveAttribute("data-dimmed", "")
        .fire(chip(outside.id), "mouseleave")
        .expect(segment(root))
        .toHaveAttribute("data-dimmed", false)
        .fire(rowOf(rowInTrunk.task), "mouseenter")
        .expect(segment(root))
        .toHaveAttribute("data-dimmed", false)
        .expect(segment(elsewhere.stack.root))
        .toHaveAttribute("data-dimmed", "");
    }),
);

const Root = Schema.Literals(["t45", "t8", "t84", "t9", "nowhere"]);

it.prop(
  "folding is the window's own: it sends no command, changes no link and flips back",
  [Root],
  ([which]) => {
    const id = TaskId.make(which);
    const once = update(reading, Message.ClickedSegment({ root: id }));
    assert(Array.fromNullishOr(once.commands)).toEqual([]);
    assert(once.model.reader.unfolded).toEqual({ [id]: true });
    assert(linkOf(once.model)).toEqual(linkOf(reading));
    const twice = update(once.model, Message.ClickedSegment({ root: id }));
    assert(Array.fromNullishOr(twice.commands)).toEqual([]);
    assert(twice.model.reader.unfolded).toEqual({ [id]: false });
    assert(modifyFields(twice.model, { reader: () => reading.reader })).toEqual(reading);
  },
);

it("a link brings a task in the folded trunk into view through the same selector", () => {
  // The chip while it is drawn, the segment whose `data-holds` has the ID as a word while it is not.
  assert(stackTaskSelectorOf("t47")).toBe(
    '[data-stacks-pane] [data-task="t47"], [data-stacks-pane] [data-holds~="t47"]',
  );
  const selectors = [stackTaskSelectorOf("t47")];
  assert(linkTargetsOf(demoTrace, { id: TaskId.make("t47"), kind: "task" })).toEqual([
    { block: "nearest", selectors },
  ]);
  // A segment step names the box, then the root's chip or the segment that stands for it.
  const targets = linkTargetsOf(demoTrace, { kind: "segment", root });
  assert(Array.flatMap(targets, (target) => Array.takeRight(target.selectors, 1))).toEqual([
    stackTaskSelectorOf("t45"),
  ]);
});

it.effect("a box whose every task is finished is its segment alone", () =>
  Effect.gen(function* () {
    const whole = Option.getOrThrow(
      Array.findFirst(boxes, (box) => box.rows === 0 && Option.isSome(box.maybeTrunk)),
    );
    const only = Option.getOrThrow(whole.maybeTrunk);
    const s = yield* viewerScene(reading);
    s.pipe(opened)
      .expect(inside(stack(whole), segment(only.root)))
      .toExist()
      .pipe(
        forEachStep(only.tasks, (step, id) =>
          step.expect(inside(stack(whole), chip(id))).toBeAbsent(),
        ),
      )
      .click(segment(only.root))
      .pipe(
        forEachStep(only.tasks, (step, id) =>
          step.expect(inside(stack(whole), chip(id))).toExist(),
        ),
      );
  }),
);

/** Where a task row in the spec pane and the segment in the stacks pane were measured. */
const measuredRowAndSegment: Measured = {
  boxes: {
    [rowKey(rowInTrunk.spec, rowInTrunk.task)]: { height: 20, width: 40, x: 500, y: 100 },
    [segmentKey(root)]: { height: 20, width: 40, x: 900, y: 300 },
  },
  panes: {
    prd: { height: 600, width: 500, x: 0, y: 0 },
    spec: { height: 600, width: 400, x: 500, y: 0 },
    stacks: { height: 600, width: 300, x: 900, y: 0 },
  },
};
const curve = inside(data("wire-layer"), both(tag("path"), data("wire-target", `segment:${root}`)));

it.effect(
  "a curve from a task row to a task in the folded trunk ends on the segment, and lights with the row",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(openedWith(measuredRowAndSegment), pinnedOnTrunk)
        .expect(curve)
        .toHaveAttribute("data-wire-source", `row:${rowInTrunk.spec}:${rowInTrunk.task}`)
        .expect(curve)
        .toHaveAttribute("data-lit", false)
        .fire(rowOf(rowInTrunk.task), "mouseenter")
        .expect(curve)
        .toHaveAttribute("data-lit", "")
        .fire(rowOf(rowInTrunk.task), "mouseleave")
        // Unfolded, the curve ends on the task's chip.
        .click(segment(root))
        .expect(curve)
        .toBeAbsent();
    }),
);
