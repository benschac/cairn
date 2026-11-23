import { ParticipantId, SectionId, Sha, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Result, Schema } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";

import { boundsOf, fitViewport } from "../src/canvas.ts";
import { FocusDrawerHeading, FocusNode } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { Size } from "../src/geometry.ts";
import { init } from "../src/init.ts";
import { loadDemoTrace } from "../src/load.ts";
import { Message } from "../src/message.ts";
import { Drawer, PresenceConnection, TraceData, selectedNodeOf } from "../src/model.ts";
import { Node } from "../src/trace.ts";
import { LoadTrace, update } from "../src/update.ts";

const settled = (result: Result.Result<typeof demoTrace, string>) =>
  Message.SettledLoadTrace({ result });
const focusedHeading = Command.resolve(FocusDrawerHeading, Message.CompletedFocusDrawerHeading());
const focusedNode = Command.resolve(FocusNode, Message.CompletedFocusNode());

/** The Commands init returns are not the result of a Message, so this step seeds the story with them. */
const started = (simulation: Parameters<ReturnType<typeof given>>[0]) => {
  const initial = init();
  return { ...simulation, commands: initial.commands ?? [], model: initial.model };
};

const task = Option.getOrThrow(Array.head(demoTrace.tasks));
const taskNode: Node = { id: task.id, kind: "task" };
const sectionNode: Node = {
  id: Schema.decodeSync(SectionId)(Array.headNonEmpty(task.specSections)),
  kind: "section",
};
const ordinary = init().model;
const opened = (node: Node) =>
  modifyFields(ordinary, { drawer: () => Drawer.Open({ maybeCommitSha: Option.none(), node }) });

// LOADING

it("init issues LoadTrace, and a failed first load is a Failure", () => {
  story(
    update,
    started,
    Command.expectExact(LoadTrace),
    Command.resolve(LoadTrace, settled(Result.fail("boom"))),
    model((next) => assert(next.trace).toEqual(TraceData.Failure({ error: "boom" }))),
  );
});

it("a successful first load is a Success", () => {
  story(
    update,
    started,
    Command.resolve(LoadTrace, settled(Result.succeed(demoTrace))),
    model((next) => assert(next.trace).toEqual(TraceData.Success({ data: demoTrace }))),
  );
});

it.prop(
  "a failed reload keeps the last good trace, and a later load clears the error",
  [Schema.String],
  ([error]) => {
    story(
      update,
      started,
      Command.resolve(LoadTrace, settled(Result.succeed(demoTrace))),
      message(settled(Result.fail(error))),
      model((next) => assert(next.trace).toEqual(TraceData.Stale({ data: demoTrace, error }))),
      message(settled(Result.succeed(demoTrace))),
      model((next) => assert(next.trace).toEqual(TraceData.Success({ data: demoTrace }))),
    );
  },
);

it.effect("the integration of loadDemoTrace decodes the bundled demo file", () =>
  Effect.map(loadDemoTrace, (trace) => assert(trace).toEqual(demoTrace)),
);

// DRAWER

it.prop(
  "clicking a node from a closed drawer opens it and focuses its heading",
  { node: Node },
  ({ node }) => {
    story(
      update,
      given(ordinary),
      message(Message.ClickedNode({ node })),
      Command.expectExact(FocusDrawerHeading),
      focusedHeading,
      model((next) => assert(selectedNodeOf(next.drawer)).toEqual(Option.some(node))),
    );
  },
);

it.prop(
  "clicking the open node closes its drawer and moves no focus",
  { node: Node },
  ({ node }) => {
    story(
      update,
      given(opened(node)),
      message(Message.ClickedNode({ node })),
      Command.expectNone(),
      model((next) => assert(next.drawer).toEqual(Drawer.Closed())),
    );
  },
);

it("clicking another node swaps the drawer to it", () => {
  story(
    update,
    given(opened(taskNode)),
    message(Message.ClickedNode({ node: sectionNode })),
    focusedHeading,
    model((next) => assert(selectedNodeOf(next.drawer)).toEqual(Option.some(sectionNode))),
  );
});

it.prop(
  "closing the drawer returns focus to the node that opened it",
  { node: Node },
  ({ node }) => {
    story(
      update,
      given(opened(node)),
      message(Message.ClickedCloseDrawer()),
      Command.expectExact(FocusNode({ node })),
      focusedNode,
      model((next) => assert(next.drawer).toEqual(Drawer.Closed())),
    );
  },
);

it("closing a closed drawer does nothing", () => {
  story(
    update,
    given(ordinary),
    message(Message.ClickedCloseDrawer()),
    Command.expectNone(),
    model((next) => assert(next).toBe(ordinary)),
  );
});

it.prop("a commit click while the drawer is closed is ignored", { sha: Sha }, ({ sha }) => {
  story(
    update,
    given(ordinary),
    message(Message.ClickedCommit({ sha })),
    Command.expectNone(),
    model((next) => assert(next).toBe(ordinary)),
  );
});

it.prop(
  "a commit click in an open drawer records the sha, even one the trace does not hold",
  { node: Node, sha: Sha },
  ({ node, sha }) => {
    story(
      update,
      given(opened(node)),
      message(Message.ClickedCommit({ sha })),
      model((next) =>
        assert(next.drawer).toEqual(Drawer.Open({ maybeCommitSha: Option.some(sha), node })),
      ),
    );
  },
);

it.prop(
  "a task clicked in a drawer opens that task and focuses the heading",
  { id: TaskId },
  ({ id }) => {
    story(
      update,
      given(opened(sectionNode)),
      message(Message.ClickedDrawerTask({ id })),
      focusedHeading,
      model((next) =>
        assert(selectedNodeOf(next.drawer)).toEqual(Option.some({ id, kind: "task" })),
      ),
    );
  },
);

// HOVER

it("leaving a node with nothing hovered leaves nothing hovered", () => {
  story(
    update,
    given(ordinary),
    message(Message.LeftNode()),
    model((next) => assert(next.maybeHovered).toEqual(Option.none())),
  );
});

it.prop("hovering a node then leaving it clears the hover", { node: Node }, ({ node }) => {
  story(
    update,
    given(ordinary),
    message(Message.HoveredNode({ node })),
    model((next) => assert(next.maybeHovered).toEqual(Option.some(node))),
    message(Message.LeftNode()),
    model((next) => assert(next.maybeHovered).toEqual(Option.none())),
  );
});

// CURVES

it("all curves start hidden, and the toggle shows them and hides them again", () => {
  story(
    update,
    given(ordinary),
    model((next) => assert(next.isShowingAllCurves).toBe(false)),
    message(Message.ClickedShowAllCurves()),
    Command.expectNone(),
    model((next) => assert(next.isShowingAllCurves).toBe(true)),
    message(Message.ClickedShowAllCurves()),
    model((next) => assert(next.isShowingAllCurves).toBe(false)),
  );
});

// FIT

const rect = { height: 100, width: 200, x: 50, y: 30 };
const pane: Size = { height: 600, width: 1200 };

it("fit does nothing until the layout and the pane are both measured", () => {
  story(
    update,
    given(ordinary),
    message(Message.ClickedFit()),
    model((next) => assert(next).toBe(ordinary)),
    message(Message.MeasuredPane({ size: pane })),
    message(Message.ClickedFit()),
    model((next) => assert(next.viewport).toEqual(ordinary.viewport)),
  );
});

it("fit frames the measured nodes in the pane", () => {
  story(
    update,
    given(ordinary),
    message(Message.MeasuredLayout({ positions: { "t-1": rect } })),
    message(Message.MeasuredPane({ size: pane })),
    message(Message.ClickedFit()),
    model((next) =>
      assert(next.viewport).toEqual(
        fitViewport(Option.getOrThrow(boundsOf({ "t-1": rect })), pane.width, pane.height),
      ),
    ),
  );
});

// PRESENCE

it("the presence connection opens, then closes and forgets the room", () => {
  const you = ParticipantId.make("p1");
  story(
    update,
    given(ordinary),
    model((next) => assert(next.presenceConnection).toEqual(PresenceConnection.Connecting())),
    message(Message.OpenedPresence()),
    model((next) => assert(next.presenceConnection).toEqual(PresenceConnection.Connected())),
    message(
      Message.ReceivedPresence({
        presence: {
          participants: [{ cursor: Option.none(), id: you, kind: "human", name: "Ada" }],
          you,
        },
      }),
    ),
    model((next) => assert(next.maybeYou).toEqual(Option.some(you))),
    message(Message.ClosedPresence()),
    model((next) => {
      assert(next.presenceConnection).toEqual(PresenceConnection.Disconnected());
      assert(next.maybeYou).toEqual(Option.none());
      assert(next.participants).toEqual([]);
    }),
  );
});

it.prop("a pan and zoom failure is recorded with its reason", [Schema.String], ([reason]) => {
  story(
    update,
    given(ordinary),
    message(Message.FailedPanZoomCanvas({ reason })),
    model((next) => assert(next.maybePanZoomFailure).toEqual(Option.some(reason))),
  );
});
