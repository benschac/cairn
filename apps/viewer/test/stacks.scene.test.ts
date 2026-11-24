import { TaskId } from "@cairn/contract";
import { labelOf, stacksOf, type Stack } from "@cairn/core/stacks";
import { expect as assert, it } from "@effect/vitest";
import { Array, Number, Option, Record } from "effect";
import { all, expect, expectAll, given, role, scene, selector, within } from "foldkit/scene";

import { demoTrace } from "../src/demo.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import { loaded, mounted } from "./fixtures.ts";

const stacks = stacksOf(demoTrace.tasks);
const stackOf = (id: string): Stack =>
  Option.getOrThrow(Array.findFirst(stacks, (stack) => Record.has(stack.cells, TaskId.make(id))));
const card = (id: string) => selector(`[data-task="${id}"]`);
const box = (stack: Stack) => selector(`[data-stack="${stack.number}"]`);

it("every stack is a box with its label, holding its own tasks", () => {
  const viewer = stackOf("t52");
  scene(
    { update, view },
    given(loaded),
    mounted,
    expectAll(all.selector("[data-stack]")).toHaveCount(stacks.length),
    ...Array.map(stacks, (stack) =>
      expect(selector(`[data-stack="${stack.number}"] [data-stack-label]`)).toHaveText(
        labelOf(stack),
      ),
    ),
    expect(within(box(stackOf("t6")), selector("[data-stack-label]"))).toHaveText(
      "Stack 6 · contract",
    ),
    expect(role("group", { name: labelOf(viewer) })).toHaveAttr("data-stack", `${viewer.number}`),
    ...Array.map(Record.keys(viewer.cells), (id) =>
      expect(within(box(viewer), card(id))).toExist(),
    ),
    expect(within(box(viewer), card("t9"))).toBeAbsent(),
  );
});

it("a child card sits in the row above its parent, in the same box and column", () => {
  // t6 is built on t9, so t9 starts the stack and t6 sits on it. A grid row counts down from the
  // box's top row, so the parent's grid row is one more than the child's.
  const stack = stackOf("t6");
  assert(stack.root).toBe("t9");
  const top = Array.reduce(Record.values(stack.cells), 1, (highest, cell) =>
    Number.max(highest, cell.row),
  );
  assert(top).toBeGreaterThan(2);
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(within(box(stack), card("t9"))).toHaveStyle("grid-row", `${top}`),
    expect(within(box(stack), card("t6"))).toHaveStyle("grid-row", `${top - 1}`),
    expect(card("t9")).toHaveStyle("grid-column", "1"),
    expect(card("t6")).toHaveStyle("grid-column", "1"),
  );
});

it("the levels run from the top down to the base branch bar, which is not a node", () => {
  const top = Array.reduce(stacks, 1, (highest, stack) => Number.max(highest, stack.level));
  const waiting = stackOf("t10");
  assert(top).toBeGreaterThan(1);
  assert(waiting.level).toBeGreaterThan(stackOf("t9").level);
  scene(
    { update, view },
    given(loaded),
    mounted,
    // The first row in the column is the highest level.
    expect(selector("[data-stacks] [data-level]")).toHaveAttr("data-level", `${top}`),
    expectAll(all.selector("[data-level]")).toHaveCount(top),
    expect(selector(`[data-level="${waiting.level}"] [data-stack="${waiting.number}"]`)).toExist(),
    expect(selector('[data-level="1"] [data-stack="1"]')).toExist(),
    expect(selector("[data-stacks] [data-base-branch]")).toHaveText("main"),
    expect(selector("[data-base-branch]")).toHaveAttr("data-base-branch", demoTrace.baseBranch),
    expect(selector("[data-base-branch] button")).toBeAbsent(),
    expect(selector("[data-base-branch][data-task]")).toBeAbsent(),
    expect(selector("[data-base-branch][data-section]")).toBeAbsent(),
  );
});

it("a card reads like a diagram node: ID, short branch, GATE, title, worktree and model band", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(selector('[data-task="t1"] [data-gate]')).toHaveText("GATE"),
    expect(card("t1")).toHaveStyle("border", "3px solid #dc2626"),
    expect(card("t9")).toHaveStyle("border", "1px solid #94a3b8"),
    expect(selector('[data-task="t9"] [data-gate]')).toBeAbsent(),
    expect(selector('[data-task="t9"] [data-field="branch"]')).toHaveText("09-trailer-schema"),
    expect(selector('[data-task="t1"] [data-field="worktree"]')).toHaveText("main checkout"),
    expect(selector('[data-task="t2"] [data-field="worktree"]')).toHaveText("wt-1"),
    expect(selector('[data-task="t1"] [data-model]')).toHaveText("opus"),
    expect(selector('[data-task="t1"] [data-model]')).toHaveStyle("background", "#7c3aed"),
    expect(selector('[data-task="t9"] [data-model]')).toHaveStyle("background", "#2563eb"),
    expect(selector('[data-task="t11"] [data-model]')).toHaveStyle("background", "#facc15"),
    expect(
      within(
        role("region", { name: "Stacks" }),
        role("button", { name: "t1 · 01-redact · GATE Redact secrets from session logs" }),
      ),
    ).toExist(),
    expect(selector('[data-task="t9"] [data-status]')).toHaveText("done"),
  );
});
