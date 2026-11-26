import { PrdSectionId, SectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Result, Schema } from "effect";
import { modifyFields } from "foldkit/struct";

import { FetchPatch, FetchSession } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen, TraceData } from "../src/model.ts";
import type { Node } from "../src/trace.ts";
import { ScrollPrdSection, update } from "../src/update.ts";
import { DETAIL_PADDING } from "../src/view/detailView.ts";
import { DETAIL_HANDLE_WIDTH } from "../src/view/dividerView.ts";
import {
  attr,
  both,
  containing,
  data,
  detailDividerRunning,
  drawnDiff,
  focusedHeading,
  loaded,
  pushedUrl,
  readerMounted,
  resolved,
  sessionWith,
  styled,
  viewerScene,
  type ViewerSteps,
} from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const task = (id: string): Node => ({ id: Schema.decodeSync(TaskId)(id), kind: "task" });
const spec = (id: string): Node => ({ id: Schema.decodeSync(SectionId)(id), kind: "section" });
const opened = (...detail: ReadonlyArray<Node>) => modifyFields(reading, { detail: () => detail });

const escape = (s: ViewerSteps) => s.fireDocument("keydown", { key: "Escape" });

const panel = data("detail");
const heading = attr("id", "detail-heading");
const steps = data("trail-step");

/** A task with a commit, the PRD section its spec section implements, and that spec section. */
const task6 = Option.getOrThrow(Array.findFirst(demoTrace.tasks, (each) => each.id === "t6"));
const commit = Option.getOrThrow(Array.head(task6.commits));
const SPEC = "spec.contract.manifest";
const PRD = "prd.manifest-schema";
/** Opening the task asks for its whole diff. */
const wholePath = `/api/diffs/${Option.getOrThrow(Array.head(commit.parents))}/${commit.sha}`;
const fetchedWhole = resolved(
  FetchPatch,
  Message.ReceivedPatch({ path: wholePath, result: Result.succeed("") }),
);
const row = data("task-row", `${SPEC}:t6`);
const statusLine = data("status-line", PRD);
/** A click that writes the address, then moves focus to the panel's heading. */
const opens = (s: ViewerSteps) => s.pipe(pushedUrl, focusedHeading);

it.effect(
  "clicking a task row opens the panel on that task, heading and focus first, with the reader under it",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .click(statusLine)
        .pipe(pushedUrl)
        .click(row)
        .pipe(opens, detailDividerRunning, fetchedWhole, drawnDiff)
        .expect(panel)
        .toHaveAttribute("data-detail-id", "t6")
        .expect(heading)
        .toHaveText(containing(`t6 ${task6.title}`))
        .expect(data("detail-part", "where"))
        .toHaveText(containing(task6.branch))
        .expect(data("detail-part", "where"))
        .toHaveText(containing("Stack "))
        .expect(data("detail-ran"))
        .toHaveText(containing("sonnet"))
        .expect(steps)
        .toHaveCount(1)
        .expect(data("reader-grid"))
        .toExist()
        .expect(data("spec-pane"))
        .toExist();
    }),
);

it.effect(
  "a spec section opened from Traces to is a second step; the first step goes back, Escape closes",
  () =>
    Effect.gen(function* () {
      const first = yield* viewerScene(opened(task("t6")));
      first
        .pipe(readerMounted, detailDividerRunning)
        .expect(data("detail-prd", "prd.manifest-schema"))
        .toExist()
        .click(data("detail-add", `section:${SPEC}`))
        .pipe(opens)
        .expect(panel)
        .toHaveAttribute("data-detail", "section")
        .expect(panel)
        .toHaveAttribute("data-detail-id", SPEC)
        .expect(steps)
        .toHaveCount(2)
        .expect(data("trail-step", "1"))
        .toHaveAttribute("aria-current", "step")
        .click(data("trail-step", "0"))
        .pipe(opens, fetchedWhole, drawnDiff)
        .expect(steps)
        .toHaveCount(1)
        .expect(panel)
        .toHaveAttribute("data-detail-id", "t6");
      const second = yield* viewerScene(opened(task("t6"), spec(SPEC)));
      second
        .pipe(readerMounted, detailDividerRunning)
        .expect(steps)
        .toHaveCount(2)
        .pipe(escape, opens, fetchedWhole, drawnDiff)
        .expect(steps)
        .toHaveCount(1)
        .expect(panel)
        .toHaveAttribute("data-detail-id", "t6")
        .pipe(escape, pushedUrl)
        .expect(panel)
        .toBeAbsent()
        .expect(data("reader-grid"))
        .toExist();
    }),
);

it.effect("the close button empties the trail", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(opened(task("t6"), spec(SPEC)));
    s.pipe(readerMounted, detailDividerRunning)
      .click(data("detail-close"))
      .pipe(pushedUrl)
      .expect(panel)
      .toBeAbsent();
  }),
);

/**
 * The demo trace with t41, which sits on t40, also depending on t39 below it. No task in the
 * manifest has a parent and another dependency, so the test adds one.
 */
const alsoNeedsT39 = modifyFields(reading, {
  trace: () =>
    TraceData.Success({
      data: modifyFields(demoTrace, {
        tasks: (tasks) =>
          Array.map(tasks, (each) =>
            each.id === "t41"
              ? modifyFields(each, {
                  dependsOn: (dependsOn) =>
                    Array.append(dependsOn, Schema.decodeSync(TaskId)("t39")),
                })
              : each,
          ),
      }),
    }),
});

it.effect(
  "a task with a parent and another dependency names both, and the dependency opens as a step",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(modifyFields(alsoNeedsT39, { detail: () => [task("t41")] }));
      s.pipe(readerMounted, detailDividerRunning)
        .expect(data("detail-parent"))
        .toHaveText(containing("on t40"))
        .expect(data("detail-depends"))
        .toHaveText(containing("t39"))
        .expect(data("detail-add", "task:t40"))
        .toBeAbsent()
        .click(data("detail-add", "task:t39"))
        .pipe(opens)
        .expect(steps)
        .toHaveCount(2)
        .expect(panel)
        .toHaveAttribute("data-detail-id", "t39");
    }),
);

it.effect("a task with no parent is from main", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(opened(task("t8")));
    s.pipe(readerMounted, detailDividerRunning)
      .expect(data("detail-parent"))
      .toHaveText(containing("from main"))
      .expect(data("detail-depends"))
      .toBeAbsent();
  }),
);

it.effect("a gated task shows the reasons for its gate", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(opened(task("t1")));
    s.pipe(readerMounted, detailDividerRunning).expect(data("drawer-part", "gate")).toExist();
  }),
);

it.effect("a PRD section a task traces to scrolls the PRD pane to it", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(opened(task("t6")));
    s.pipe(readerMounted, detailDividerRunning)
      .click(data("detail-prd", "prd.manifest-schema"))
      .pipe(resolved(ScrollPrdSection, Message.CompletedScrollPrdSection()))
      .expect(steps)
      .toHaveCount(1);
    // The trail is not touched: the panel stays open on the task beside the scrolled PRD.
    assert(
      update(opened(task("t6")), Message.ClickedTraceSection({ id: PrdSectionId.make(PRD) })).model
        .detail,
    ).toEqual([task("t6")]);
  }),
);

it.effect("a spec section shows its summary, key chips, tasks and judgments", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(opened(spec("spec.viewer.detail-panel")));
    s.pipe(readerMounted, detailDividerRunning)
      .expect(heading)
      .toHaveText(containing("Detail panel"))
      .expect(data("detail-part", "summary"))
      .toExist()
      .expect(data("detail-key", "Implements"))
      .toExist()
      .expect(data("detail-add", "task:t93"))
      .toExist()
      .expect(data("drawer-part", "judgments"))
      .toExist();
  }),
);

it.effect("a row, then a commit: the code view on that commit, two clicks from the section", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(statusLine)
      .pipe(pushedUrl)
      .click(row)
      .pipe(opens, detailDividerRunning, fetchedWhole, drawnDiff)
      .click(data("detail-commit", commit.sha))
      .pipe(
        pushedUrl,
        resolved(
          FetchPatch,
          Message.ReceivedPatch({ path: `/api/commits/${commit.sha}`, result: Result.succeed("") }),
        ),
        // The diff is keyed by its session once it is read, so the session's arrival draws it again.
        drawnDiff,
        resolved(
          FetchSession,
          Message.ReceivedSession({
            id: `${commit.session}`,
            result: Result.succeed(sessionWith(`${commit.session}`)),
          }),
        ),
        drawnDiff,
      )
      .expect(data("tree-commit", commit.sha))
      .toHaveAttribute("aria-current", "true");
  }),
);

it.effect(
  "the resize handle reaches less far into the panel than its content's padding, so no control sits under it",
  () =>
    Effect.gen(function* () {
      assert(DETAIL_HANDLE_WIDTH / 2).toBeLessThanOrEqual(DETAIL_PADDING);
      const s = yield* viewerScene(opened(task("t6")));
      s.pipe(readerMounted, detailDividerRunning)
        .expect(both(data("divider", "detail"), styled("width", `${DETAIL_HANDLE_WIDTH}px`)))
        .toExist()
        .expect(both(data("detail-handle"), styled("left", `-${DETAIL_HANDLE_WIDTH / 2}px`)))
        .toExist()
        .expect(both(data("detail-content"), styled("padding", `12px ${DETAIL_PADDING}px`)))
        .toExist();
    }),
);
