import { PrdSectionId, SectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Result, Schema } from "effect";
import {
  Command,
  Mount,
  Subscription,
  all,
  click,
  expect,
  expectAll,
  given,
  scene,
  selector,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { FetchPatch } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { RenderDiff } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import type { Node } from "../src/trace.ts";
import { ScrollPrdSection, update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { view } from "../src/view/view.ts";
import { focusedDetailHeading, loaded, unmeasuredWires } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const task = (id: string): Node => ({ id: Schema.decodeSync(TaskId)(id), kind: "task" });
const spec = (id: string): Node => ({ id: Schema.decodeSync(SectionId)(id), kind: "section" });
const opened = (...detail: ReadonlyArray<Node>) => modifyFields(reading, { detail: () => detail });

const scrolledTop = Mount.resolveAll(
  [TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })],
  [ScrollStacksToBottom, Message.CompletedScrollStacks()],
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);
const escape = Subscription.emit(Message.PressedEscape());

const panel = selector("[data-detail]");
const heading = selector("#detail-heading");
const steps = all.selector("[data-trail-step]");

/** A task with a commit, the PRD section its spec section implements, and that spec section. */
const task6 = Option.getOrThrow(Array.findFirst(demoTrace.tasks, (each) => each.id === "t6"));
const commit = Option.getOrThrow(Array.head(task6.commits));
const SPEC = "spec.contract.manifest";
const PRD = "prd.manifest-schema";
const row = selector(`[data-task-row="${SPEC}:t6"]`);
const statusLine = selector(`[data-status-line="${PRD}"]`);

it("clicking a task row opens the panel on that task, heading and focus first, with the reader under it", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTop,
    click(statusLine),
    click(row),
    focusedDetailHeading,
    expect(panel).toHaveAttr("data-detail-id", "t6"),
    expect(heading).toContainText(`t6 ${task6.title}`),
    expect(selector("[data-detail-part='where']")).toContainText(task6.branch),
    expect(selector("[data-detail-part='where']")).toContainText("Stack "),
    expect(selector("[data-detail-ran]")).toContainText("sonnet"),
    expectAll(steps).toHaveCount(1),
    expect(selector("[data-reader-grid]")).toExist(),
    expect(selector("[data-spec-pane]")).toExist(),
  );
});

it("a spec section opened from Traces to is a second step; the first step goes back, Escape closes", () => {
  scene(
    { update, view },
    given(opened(task("t6"))),
    scrolledTop,
    expect(selector("[data-detail-prd='prd.manifest-schema']")).toExist(),
    click(selector(`[data-detail-add="section:${SPEC}"]`)),
    focusedDetailHeading,
    expect(panel).toHaveAttr("data-detail", "section"),
    expect(panel).toHaveAttr("data-detail-id", SPEC),
    expectAll(steps).toHaveCount(2),
    expect(selector("[data-trail-step='1']")).toHaveAttr("aria-current", "step"),
    click(selector("[data-trail-step='0']")),
    focusedDetailHeading,
    expectAll(steps).toHaveCount(1),
    expect(panel).toHaveAttr("data-detail-id", "t6"),
  );
  scene(
    { update, view },
    given(opened(task("t6"), spec(SPEC))),
    scrolledTop,
    expectAll(steps).toHaveCount(2),
    escape,
    focusedDetailHeading,
    expectAll(steps).toHaveCount(1),
    expect(panel).toHaveAttr("data-detail-id", "t6"),
    escape,
    expect(panel).toBeAbsent(),
    expect(selector("[data-reader-grid]")).toExist(),
  );
});

it("the close button empties the trail", () => {
  scene(
    { update, view },
    given(opened(task("t6"), spec(SPEC))),
    scrolledTop,
    click(selector("[data-detail-close]")),
    expect(panel).toBeAbsent(),
  );
});

it("a task with a parent and another dependency names both, and the dependency opens as a step", () => {
  scene(
    { update, view },
    given(opened(task("t68"))),
    scrolledTop,
    expect(selector("[data-detail-parent]")).toContainText("on t52"),
    expect(selector("[data-detail-depends]")).toContainText("t39"),
    expect(selector("[data-detail-add='task:t52']")).toBeAbsent(),
    click(selector("[data-detail-add='task:t39']")),
    focusedDetailHeading,
    expectAll(steps).toHaveCount(2),
    expect(panel).toHaveAttr("data-detail-id", "t39"),
  );
});

it("a task with no parent is from main", () => {
  scene(
    { update, view },
    given(opened(task("t8"))),
    scrolledTop,
    expect(selector("[data-detail-parent]")).toContainText("from main"),
    expect(selector("[data-detail-depends]")).toBeAbsent(),
  );
});

it("a gated task shows the reasons for its gate", () => {
  scene(
    { update, view },
    given(opened(task("t1"))),
    scrolledTop,
    expect(selector("[data-drawer-part='gate']")).toExist(),
  );
});

it("a PRD section a task traces to scrolls the PRD pane to it", () => {
  scene(
    { update, view },
    given(opened(task("t6"))),
    scrolledTop,
    click(selector("[data-detail-prd='prd.manifest-schema']")),
    Command.resolve(
      ScrollPrdSection({ id: PrdSectionId.make(PRD) }),
      Message.CompletedScrollPrdSection(),
    ),
    expectAll(steps).toHaveCount(1),
  );
  // The trail is not touched: the panel stays open on the task beside the scrolled PRD.
  assert(
    update(opened(task("t6")), Message.ClickedTraceSection({ id: PrdSectionId.make(PRD) })).model
      .detail,
  ).toEqual([task("t6")]);
});

it("a spec section shows its summary, key chips, tasks and judgments", () => {
  scene(
    { update, view },
    given(opened(spec("spec.viewer.detail-panel"))),
    scrolledTop,
    expect(heading).toContainText("Detail panel"),
    expect(selector("[data-detail-part='summary']")).toExist(),
    expect(selector("[data-detail-key='Implements']")).toExist(),
    expect(selector("[data-detail-add='task:t93']")).toExist(),
    expect(selector("[data-drawer-part='judgments']")).toExist(),
  );
});

it("a row, then a commit: the code view on that commit, two clicks from the section", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTop,
    click(statusLine),
    click(row),
    focusedDetailHeading,
    click(selector(`[data-detail-commit="${commit.sha}"]`)),
    Mount.expectEnded(TrackPrdScroll),
    Mount.expectEnded(ScrollStacksToBottom),
    Mount.expectEnded(MeasureWires),
    Command.resolve(
      FetchPatch({ path: `/api/commits/${commit.sha}` }),
      Message.ReceivedPatch({ path: `/api/commits/${commit.sha}`, result: Result.succeed("") }),
    ),
    Mount.resolve(RenderDiff, Message.CompletedRenderDiff()),
    expect(selector(`[data-tree-commit="${commit.sha}"]`)).toHaveAttr("aria-current", "true"),
  );
});
