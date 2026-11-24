import { PrdSectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Number, Option, Record } from "effect";
import {
  Mount,
  all,
  click,
  expect,
  expectAll,
  given,
  role,
  scene,
  selector,
  within,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { labelOf, stacksOf, type Stack } from "../src/stacks.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom, chipTitleOf } from "../src/view/stackChipsView.ts";
import { view } from "../src/view/view.ts";
import { focusedDetailHeading, loaded, wiresMounted } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const stacks = stacksOf(demoTrace.tasks);
const stackOf = (id: string): Stack =>
  Option.getOrThrow(Array.findFirst(stacks, (stack) => Record.has(stack.cells, TaskId.make(id))));
const box = (stack: Stack) => selector(`[data-stack="${stack.number}"]`);
const chip = (id: string) => selector(`[data-task="${id}"]`);
const scrolledTo = (id: string) =>
  Mount.resolve(TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make(id) }));
const scrolledStacks = Mount.resolve(ScrollStacksToBottom, Message.CompletedScrollStacks());

/** The reader, with the pane's mounts answered. */
const opened = [scrolledTo("prd.goal"), scrolledStacks, wiresMounted] as const;

it("every stack is a box with its label for a title, holding its own chips", () => {
  const viewer = stackOf("t52");
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(role("region", { name: "Stacks" })).toExist(),
    expectAll(all.selector("[data-stacks-pane] [data-stack]")).toHaveCount(stacks.length),
    ...Array.map(stacks, (stack) => expect(box(stack)).toHaveAttr("title", labelOf(stack))),
    expect(role("group", { name: labelOf(viewer) })).toHaveAttr("data-stack", `${viewer.number}`),
    ...Array.map(Record.keys(viewer.cells), (id) =>
      expect(within(box(viewer), chip(id))).toExist(),
    ),
    expect(within(box(viewer), chip("t9"))).toBeAbsent(),
    expect(within(box(viewer), selector("[data-stack-label]"))).toHaveText(`${viewer.number}`),
    expectAll(all.selector("[data-stacks-pane] [data-task]")).toHaveCount(demoTrace.tasks.length),
  );
});

it("a child chip sits in the row above its parent, in the same box", () => {
  const stack = stackOf("t6");
  assert(stack.root).toBe("t9");
  const top = Array.reduce(Record.values(stack.cells), 1, (highest, cell) =>
    Number.max(highest, cell.row),
  );
  assert(top).toBeGreaterThan(2);
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(within(box(stack), chip("t9"))).toHaveStyle("grid-row", `${top}`),
    expect(within(box(stack), chip("t6"))).toHaveStyle("grid-row", `${top - 1}`),
  );
});

it("the levels run from the top down to the base branch bar, which is not a node", () => {
  const top = Array.reduce(stacks, 1, (highest, stack) => Number.max(highest, stack.level));
  const waiting = stackOf("t10");
  assert(top).toBeGreaterThan(1);
  assert(waiting.level).toBeGreaterThan(stackOf("t9").level);
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(selector("[data-stacks] [data-level]")).toHaveAttr("data-level", `${top}`),
    expectAll(all.selector("[data-level]")).toHaveCount(top),
    expect(selector(`[data-level="${waiting.level}"] [data-stack="${waiting.number}"]`)).toExist(),
    expect(selector('[data-level="1"] [data-stack="1"]')).toExist(),
    expect(selector("[data-stacks-pane] [data-base-branch]")).toHaveText(demoTrace.baseBranch),
    expect(selector(".base-bar")).toHaveAttr("data-base-branch", demoTrace.baseBranch),
    expect(selector("[data-base-branch] button")).toBeAbsent(),
    expect(selector("[data-base-branch][data-task]")).toBeAbsent(),
    expect(selector("[data-base-branch][data-wire]")).toBeAbsent(),
  );
});

it("a gated chip has a gate mark in its border and says what it is; the others do not", () => {
  const gated = Array.filter(demoTrace.tasks, (task) => task.gate.required);
  const free = Array.filter(demoTrace.tasks, (task) => !task.gate.required);
  assert(Array.length(gated)).toBeGreaterThan(0);
  scene(
    { update, view },
    given(reading),
    ...opened,
    ...Array.map(gated, (task) => expect(chip(task.id)).toHaveAttr("data-gated", "")),
    ...Array.map(Array.take(free, 5), (task) => expect(chip(task.id)).not.toHaveAttr("data-gated")),
    expect(chip("t1")).toHaveAttr("data-wire", "task:t1"),
    expect(chip("t1")).toHaveAttr(
      "aria-label",
      chipTitleOf(
        demoTrace,
        Option.getOrThrow(Array.findFirst(demoTrace.tasks, (task) => task.id === "t1")),
      ),
    ),
    expect(chip("t1")).toHaveAttr(
      "title",
      chipTitleOf(
        demoTrace,
        Option.getOrThrow(Array.findFirst(demoTrace.tasks, (task) => task.id === "t1")),
      ),
    ),
  );
});

it("a pinned section lights its chips and their boxes and dims the rest, which still click", () => {
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
  scene(
    { update, view },
    given(reading),
    ...opened,
    click(selector(`[data-status-line="${prd}"]`)),
    expect(chip(first.id)).toHaveAttr("data-current", ""),
    expect(chip(first.id)).not.toHaveAttr("data-faded"),
    expect(box(litBox)).toHaveAttr("data-current", ""),
    expect(chip(other.id)).toHaveAttr("data-faded", ""),
    expect(chip(other.id)).not.toHaveAttr("data-current"),
    expect(selector("[data-stacks-summary]")).toContainText(
      `of ${stacks.length} stacks hold this section`,
    ),
    expect(selector("[data-stacks-summary]")).toContainText(
      `of ${demoTrace.tasks.length} tasks done`,
    ),
    expect(selector("[data-stacks-summary]")).toContainText("read up from main"),
    // A dimmed chip still takes clicks.
    click(chip(other.id)),
    focusedDetailHeading,
    expect(chip(other.id)).toExist(),
  );
});
