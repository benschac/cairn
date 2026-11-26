import { PrdSectionId, TaskId } from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import { expect as assert, it } from "@effect/vitest";
import { Array, HashSet, Option, Record, Result, Schema } from "effect";
import {
  Command,
  Mount,
  Subscription,
  all,
  click,
  expect,
  expectAll,
  given,
  hover,
  scene,
  selector,
  within,
} from "foldkit/scene";
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
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { view } from "../src/view/view.ts";
import { rowKey, segmentKey } from "../src/wires.ts";
import { focusedDetailHeading, loaded, wiresMounted, wiresMountedWith } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const boxes = stackBoxesOf(demoTrace.tasks, {});
const boxWith = (id: string) =>
  Option.getOrThrow(Array.findFirst(boxes, (box) => Record.has(box.stack.cells, TaskId.make(id))));
const viewer = boxWith("t52");
const trunk = Option.getOrThrow(viewer.maybeTrunk);
const root = trunk.root;

const stack = (box: typeof viewer) => selector(`[data-stack="${box.stack.number}"]`);
const chip = (id: string) => selector(`[data-task="${id}"]`);
const inViewer = (id: string) => within(stack(viewer), chip(id));
const segment = (id: string) => selector(`[data-segment="${id}"]`);
const forkLabel = (id: string) => selector(`[data-fork-label][data-wire="fork:${id}"]`);
const wiresAttribute = selector("[data-wires]");
const left = Subscription.emit(Message.LeftNode());

const openedWith = <Wires>(wires: Wires) =>
  [
    Mount.resolve(TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })),
    Mount.resolve(
      ScrollStacksToBottom,
      Message.CompletedScrollStacks({ maybeChartWidth: Option.none() }),
    ),
    wires,
  ] as const;
const opened = openedWith(wiresMounted);

const gridRowOf = (rows: number, row: number): number => 2 * (rows - row) + 1;

it("Stack 24 is one segment under its branches, and the branches are labelled", () => {
  assert(trunk.tasks).toEqual(Array.makeBy(8, (index) => TaskId.make(`t${45 + index}`)));
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(within(stack(viewer), segment(root))).toHaveText("t45–t52 · viewer · 8 done"),
    expectAll(all.selector("[data-segment]")).toHaveCount(
      Array.length(Array.filter(boxes, (box) => Option.isSome(box.maybeTrunk))),
    ),
    expect(segment(root)).toHaveAttr("data-holds", Array.join(trunk.tasks, " ")),
    expect(segment(root)).toHaveAttr("data-wire", "segment:t45"),
    expect(segment(root)).toHaveAttr("aria-expanded", "false"),
    expect(segment(root)).toHaveAttr("title", "t45–t52 · viewer · 8 done · click to unfold"),
    expect(segment(root)).toHaveAttr("aria-label", "t45–t52 · viewer · 8 done · click to unfold"),
    ...Array.map(trunk.tasks, (id) => expect(inViewer(id)).toBeAbsent()),
    // Row 1 stands on the segment, and each child of the fork is labelled at its foot.
    ...Array.map(
      [
        ["t69", "stacks"],
        ["t71", "fuzzy-matching"],
        ["t75", "code-view"],
        ["t67", "server"],
        ["t81", "demo-data"],
      ] as const,
      ([id, label]) => expect(forkLabel(id)).toHaveText(label),
    ),
    ...Array.map(["t69", "t71", "t75"], (id) =>
      expect(inViewer(id)).toHaveStyle("grid-row", `${gridRowOf(viewer.rows, 1)}`),
    ),
    ...Array.map(["t69", "t71", "t75"], (id) =>
      expect(forkLabel(id)).toHaveStyle("grid-row", `${gridRowOf(viewer.rows, 1) + 1}`),
    ),
    expect(forkLabel("t69")).toHaveAttr("data-wire", "fork:t69"),
  );
});

it("a chip is centred across the columns of everything built on it", () => {
  const spans = Array.filter(Record.toEntries(viewer.cells), ([, cell]) => cell.span > 1);
  assert(Array.isReadonlyArrayNonEmpty(spans)).toBe(true);
  scene(
    { update, view },
    given(reading),
    ...opened,
    ...Array.map(spans, ([id, cell]) =>
      expect(inViewer(id)).toHaveStyle("grid-column", `${cell.column} / span ${cell.span}`),
    ),
    ...Array.map(spans, ([id, cell]) =>
      expect(inViewer(id)).toHaveStyle("grid-row", `${gridRowOf(viewer.rows, cell.row)}`),
    ),
  );
});

it("clicking the segment shows the eight chips and Fold t45–t52, and clicking that folds the trunk again", () => {
  scene(
    { update, view },
    given(reading),
    ...opened,
    click(segment(root)),
    ...Array.map(trunk.tasks, (id) => expect(inViewer(id)).toExist()),
    expect(segment(root)).toHaveText("Fold t45–t52"),
    expect(segment(root)).toHaveAttr("aria-expanded", "true"),
    expect(segment(root)).toHaveAttr("data-holds", Array.join(trunk.tasks, " ")),
    expect(segment(root)).toHaveAttr("data-wire", "segment:t45"),
    // Unfolded, the chips keep the rows stacksOf gave them: the box is four rows taller.
    expect(inViewer("t45")).toHaveStyle(
      "grid-row",
      `${gridRowOf(viewer.rows + Array.length(trunk.tasks), 1)}`,
    ),
    click(segment(root)),
    ...Array.map(trunk.tasks, (id) => expect(inViewer(id)).toBeAbsent()),
    expect(segment(root)).toHaveText("t45–t52 · viewer · 8 done"),
    expect(segment(root)).toHaveAttr("aria-expanded", "false"),
  );
});

it("unfolding one trunk leaves the others folded, and the body is measured again", () => {
  const other = Option.getOrThrow(
    Array.findFirst(boxes, (box) => Option.isSome(box.maybeTrunk) && box.stack.root !== root),
  );
  assert(other.stack.root).not.toBe(root);
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(wiresAttribute).toHaveAttr("data-wires", "prd.goal|models"),
    click(segment(root)),
    expect(wiresAttribute).toHaveAttr("data-wires", "prd.goal|models|t45"),
    expect(segment(other.stack.root)).toHaveAttr("aria-expanded", "false"),
    click(segment(root)),
    expect(wiresAttribute).toHaveAttr("data-wires", "prd.goal|models"),
  );
});

it("a box whose trunk is one task, or that has no trunk, has no segment", () => {
  const lone = Option.getOrThrow(
    Array.findFirst(
      boxes,
      (box) => Option.isNone(box.maybeTrunk) && Record.has(box.cells, box.stack.root),
    ),
  );
  assert(Array.length(stacksOf(demoTrace.tasks))).toBeGreaterThan(1);
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(within(stack(lone), chip(lone.stack.root))).toExist(),
    expect(within(stack(lone), selector("[data-segment]"))).toBeAbsent(),
    expect(within(stack(lone), selector("[data-fork-label]"))).toBeAbsent(),
  );
});

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

it("a pinned section with a task inside the folded trunk marks the segment current, and the others faded", () => {
  scene(
    { update, view },
    given(reading),
    ...opened,
    // The section at the top of the PRD is current to begin with, and holds none of the trunk.
    expect(segment(root)).not.toHaveAttr("data-current"),
    expect(segment(root)).toHaveAttr("data-faded", ""),
    click(selector(`[data-status-line="${rowInTrunk.prd}"]`)),
    expect(segment(root)).toHaveAttr("data-current", ""),
    expect(segment(root)).not.toHaveAttr("data-faded"),
    expect(stack(viewer)).toHaveAttr("data-current", ""),
    expect(segment(elsewhere.stack.root)).toHaveAttr("data-faded", ""),
    expect(segment(elsewhere.stack.root)).not.toHaveAttr("data-current"),
    // Unfolded, the chips carry the marks and the bar does not.
    click(segment(root)),
    expect(segment(root)).not.toHaveAttr("data-current"),
    expect(inViewer(rowInTrunk.task)).toHaveAttr("data-current", ""),
  );
});

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
const rowOf = (id: string) => selector(`[data-task-row="${rowInTrunk.spec}:${id}"]`);
const pinnedOnTrunk = click(selector(`[data-status-line="${rowInTrunk.prd}"]`));

it("opening a task inside the folded trunk selects the segment", () => {
  const task = Option.getOrThrow(
    Array.findFirst(demoTrace.tasks, (each) => each.id === rowInTrunk.task),
  );
  scene(
    { update, view },
    given(reading),
    ...opened,
    pinnedOnTrunk,
    expect(segment(root)).not.toHaveAttr("data-selected"),
    click(rowOf(rowInTrunk.task)),
    focusedDetailHeading,
    ...Array.flatMap(Option.toArray(patchPathOf(task, WHOLE_TASK)), (path) => [
      Command.resolve(
        FetchPatch({ path }),
        // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
        Message.ReceivedPatch({ path, result: Result.succeed("") }),
      ),
      Mount.resolve(
        RenderDiff,
        // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
        Message.CompletedRenderDiff(),
      ),
    ]),
    expect(segment(root)).toHaveAttr("data-selected", ""),
    // A task elsewhere in the card is not in the trunk, and no other segment is selected.
    expectAll(all.selector("[data-segment][data-selected]")).toHaveCount(1),
  );
});

/** Whether the chain of a task holds a task of the finished trunk. */
const holdsTrunk = (id: string) =>
  Array.some(
    Array.fromIterable(chainOf(demoTrace, { id: TaskId.make(id), kind: "task" }).tasks),
    (task) => Array.contains(trunk.tasks, TaskId.make(task)),
  );

it("hovering a node outside the trunk's chain dims the segment, and one inside it does not", () => {
  const outside = Option.getOrThrow(
    Array.findFirst(
      demoTrace.tasks,
      (task) => Record.has(boxWith(task.id).cells, task.id) && !holdsTrunk(task.id),
    ),
  );
  scene(
    { update, view },
    given(reading),
    ...opened,
    pinnedOnTrunk,
    expect(segment(root)).not.toHaveAttr("data-dimmed"),
    hover(chip(outside.id)),
    expect(segment(root)).toHaveAttr("data-dimmed", ""),
    left,
    expect(segment(root)).not.toHaveAttr("data-dimmed"),
    hover(rowOf(rowInTrunk.task)),
    expect(segment(root)).not.toHaveAttr("data-dimmed"),
    expect(segment(elsewhere.stack.root)).toHaveAttr("data-dimmed", ""),
  );
});

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

it("a box whose every task is finished is its segment alone", () => {
  const whole = Option.getOrThrow(
    Array.findFirst(boxes, (box) => box.rows === 0 && Option.isSome(box.maybeTrunk)),
  );
  const only = Option.getOrThrow(whole.maybeTrunk);
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(within(stack(whole), segment(only.root))).toExist(),
    ...Array.map(only.tasks, (id) => expect(within(stack(whole), chip(id))).toBeAbsent()),
    click(segment(only.root)),
    ...Array.map(only.tasks, (id) => expect(within(stack(whole), chip(id))).toExist()),
  );
});

/** Where a task row in the spec pane and the segment in the stacks pane were measured. */
const measuredRowAndSegment = wiresMountedWith({
  boxes: {
    [rowKey(rowInTrunk.spec, rowInTrunk.task)]: { height: 20, width: 40, x: 500, y: 100 },
    [segmentKey(root)]: { height: 20, width: 40, x: 900, y: 300 },
  },
  panes: {
    prd: { height: 600, width: 500, x: 0, y: 0 },
    spec: { height: 600, width: 400, x: 500, y: 0 },
    stacks: { height: 600, width: 300, x: 900, y: 0 },
  },
});
const curve = selector(`[data-wire-layer] path[data-wire-target="segment:${root}"]`);

it("a curve from a task row to a task in the folded trunk ends on the segment, and lights with the row", () => {
  scene(
    { update, view },
    given(reading),
    ...openedWith(measuredRowAndSegment),
    pinnedOnTrunk,
    expect(curve).toHaveAttr("data-wire-source", `row:${rowInTrunk.spec}:${rowInTrunk.task}`),
    expect(curve).not.toHaveAttr("data-lit"),
    hover(rowOf(rowInTrunk.task)),
    expect(curve).toHaveAttr("data-lit", ""),
    left,
    // Unfolded, the curve ends on the task's chip.
    click(segment(root)),
    expect(curve).toBeAbsent(),
  );
});
