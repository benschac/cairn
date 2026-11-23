import { ParticipantId, SectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Record, Result, Schema } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { modifyFields } from "foldkit/struct";

import { boundsOf, fitViewport } from "../src/canvas.ts";
import { FocusDrawerHeading, FocusNode } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import {
  ClientPoint,
  DragState,
  Movable,
  NUDGE_STEP,
  PointerId,
  offsetOf,
  type ArrowKey,
} from "../src/drag.ts";
import { Size } from "../src/geometry.ts";
import { init } from "../src/init.ts";
import { loadDemoTrace } from "../src/load.ts";
import { Message } from "../src/message.ts";
import { Drawer, PresenceConnection, TraceData, selectedNodeOf } from "../src/model.ts";
import { PinColor } from "../src/highlight.ts";
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
const opened = (node: Node) => modifyFields(ordinary, { drawer: () => Drawer.Open({ node }) });

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
  "clicking a node pins it, and clicking it again unpins it, closes its drawer and moves no focus",
  { node: Node },
  ({ node }) => {
    story(
      update,
      given(ordinary),
      message(Message.ClickedNode({ node })),
      focusedHeading,
      model((next) => assert(next.pins).toEqual([{ color: "blue", node }])),
      message(Message.ClickedNode({ node })),
      Command.expectNone(),
      model((next) => {
        assert(next.drawer).toEqual(Drawer.Closed());
        assert(next.pins).toEqual([]);
      }),
    );
  },
);

it("each pin takes the next free colour, and an unpinned colour is reused first", () => {
  story(
    update,
    given(ordinary),
    message(Message.ClickedNode({ node: taskNode })),
    focusedHeading,
    message(Message.ClickedNode({ node: sectionNode })),
    focusedHeading,
    model((next) =>
      assert(next.pins).toEqual([
        { color: "blue", node: taskNode },
        { color: "rose", node: sectionNode },
      ]),
    ),
    message(Message.ClickedNode({ node: taskNode })),
    // The section's drawer is open, so unpinning the task leaves it open.
    model((next) => assert(selectedNodeOf(next.drawer)).toEqual(Option.some(sectionNode))),
    message(Message.ClickedNode({ node: taskNode })),
    focusedHeading,
    model((next) =>
      assert(next.pins).toEqual([
        { color: "rose", node: sectionNode },
        { color: "blue", node: taskNode },
      ]),
    ),
  );
});

it.prop(
  "with every colour taken, colours repeat in order",
  { ids: Schema.Array(TaskId).check(Schema.isMinLength(7), Schema.isUnique()) },
  ({ ids }) => {
    const pinned = Array.reduce(
      ids,
      ordinary,
      (current, id) => update(current, Message.ClickedNode({ node: { id, kind: "task" } })).model,
    );
    assert(Array.map(pinned.pins, (pin) => pin.color)).toEqual(
      Array.map(ids, (_id, index) => PinColor.literals[index % PinColor.literals.length]),
    );
  },
  { arbitrary: { runs: 20 } },
);

it("clearing the pins unpins every node and leaves the drawer", () => {
  story(
    update,
    given(ordinary),
    message(Message.ClickedNode({ node: taskNode })),
    focusedHeading,
    message(Message.ClickedNode({ node: sectionNode })),
    focusedHeading,
    message(Message.ClickedClearPins()),
    Command.expectNone(),
    model((next) => {
      assert(next.pins).toEqual([]);
      assert(selectedNodeOf(next.drawer)).toEqual(Option.some(sectionNode));
    }),
  );
});

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

it.prop(
  "a task clicked in a drawer opens that task and focuses the heading",
  { id: TaskId },
  ({ id }) => {
    story(
      update,
      given(opened(sectionNode)),
      message(Message.ClickedDrawerTask({ id })),
      focusedHeading,
      model((next) => assert(next.pins).toEqual([{ color: "blue", node: { id, kind: "task" } }])),
      // Clicking it in the drawer again keeps it pinned.
      message(Message.ClickedDrawerTask({ id })),
      focusedHeading,
      model((next) => assert(next.pins).toHaveLength(1)),
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

// DRAG

const t9 = Movable.Task({ id: TaskId.make("t9") });
const prd = Movable.Document({ document: "prd" });
const pointerId = 1;
const pressed = (movable: Movable, pointer = { x: 100, y: 100 }) =>
  message(Message.PressedMoveHandle({ movable, pointer, pointerId }));
const movedTo = (x: number, y: number, id = pointerId) =>
  message(Message.MovedDragPointer({ buttons: 1, pointer: { x, y }, pointerId: id }));
const atZoom = (zoom: number) => modifyFields(ordinary, { viewport: () => ({ x: 0, y: 0, zoom }) });

it("nothing is dragged or moved at first", () => {
  assert(ordinary.drag).toEqual(DragState.Idle());
  assert(ordinary.offsets).toEqual({});
});

it("pressing a grip starts dragging its item with that pointer and moves nothing yet", () => {
  story(
    update,
    given(ordinary),
    pressed(t9),
    Command.expectNone(),
    model((next) => {
      assert(next.drag).toEqual(
        DragState.Dragging({ movable: t9, pointer: { x: 100, y: 100 }, pointerId }),
      );
      assert(next.offsets).toEqual({});
    }),
  );
});

it.each([
  { expected: { x: 80, y: -40 }, zoom: 0.5 },
  { expected: { x: 40, y: -20 }, zoom: 1 },
  { expected: { x: 20, y: -10 }, zoom: 2 },
])(
  "a move at zoom $zoom moves the item by the pointer's move over the zoom",
  ({ expected, zoom }) => {
    story(
      update,
      given(atZoom(zoom)),
      pressed(t9),
      movedTo(140, 80),
      Command.expectNone(),
      model((next) => assert(offsetOf(next.offsets, t9)).toEqual(Option.some(expected))),
    );
  },
);

it("moves add up, each at the zoom of its moment", () => {
  story(
    update,
    given(ordinary),
    pressed(prd),
    movedTo(110, 100),
    message(Message.PannedOrZoomed({ viewport: { x: 0, y: 0, zoom: 2 } })),
    movedTo(130, 120),
    model((next) => {
      assert(offsetOf(next.offsets, prd)).toEqual(Option.some({ x: 20, y: 10 }));
      assert(offsetOf(next.offsets, t9)).toEqual(Option.none());
    }),
  );
});

it("a second drag starts from where the first one left the item", () => {
  story(
    update,
    given(ordinary),
    pressed(t9),
    movedTo(130, 100),
    message(Message.ReleasedDragPointer({ pointerId })),
    pressed(t9, { x: 0, y: 0 }),
    movedTo(0, 25),
    model((next) => assert(offsetOf(next.offsets, t9)).toEqual(Option.some({ x: 30, y: 25 }))),
  );
});

it("releasing ends the drag, and a later move changes nothing", () => {
  story(
    update,
    given(ordinary),
    pressed(t9),
    movedTo(120, 100),
    message(Message.ReleasedDragPointer({ pointerId })),
    model((next) => {
      assert(next.drag).toEqual(DragState.Released({ pointerId }));
      assert(offsetOf(next.offsets, t9)).toEqual(Option.some({ x: 20, y: 0 }));
    }),
    movedTo(500, 500),
    model((next) => assert(offsetOf(next.offsets, t9)).toEqual(Option.some({ x: 20, y: 0 }))),
  );
});

it.prop(
  "a move or a release with no drag in progress is ignored",
  { pointer: ClientPoint, pointerId: PointerId },
  ({ pointer, pointerId: anyPointer }) => {
    story(
      update,
      given(ordinary),
      message(Message.MovedDragPointer({ buttons: 1, pointer, pointerId: anyPointer })),
      model((next) => assert(next).toBe(ordinary)),
      message(Message.ReleasedDragPointer({ pointerId: anyPointer })),
      model((next) => assert(next).toBe(ordinary)),
    );
  },
);

it("a move or a release by another pointer is ignored", () => {
  story(
    update,
    given(ordinary),
    pressed(t9),
    movedTo(300, 300, pointerId + 1),
    message(Message.ReleasedDragPointer({ pointerId: pointerId + 1 })),
    model((next) => {
      assert(next.offsets).toEqual({});
      assert(DragState.guards.Dragging(next.drag)).toBe(true);
    }),
  );
});

const released = modifyFields(ordinary, { drag: () => DragState.Released({ pointerId }) });
const dragging = modifyFields(ordinary, {
  drag: () => DragState.Dragging({ movable: t9, pointer: { x: 0, y: 0 }, pointerId }),
});

it.each([
  { ended: Message.SuppressedClickAfterDrag(), name: "the click the release makes" },
  { ended: Message.PressedAfterDrag({ isPrimaryPointer: true }), name: "the next press" },
  {
    ended: Message.PressedAfterDrag({ isPrimaryPointer: false }),
    name: "the next key or second finger",
  },
])("$name ends a drag that was just released", ({ ended }) => {
  story(
    update,
    given(released),
    message(ended),
    Command.expectNone(),
    model((next) => assert(next.drag).toEqual(DragState.Idle())),
  );
});

it.each([
  { ended: Message.SuppressedClickAfterDrag(), name: "a suppressed click" },
  { ended: Message.PressedAfterDrag({ isPrimaryPointer: false }), name: "a second finger's press" },
])("$name is ignored with no drag just released, and during a drag", ({ ended }) => {
  story(
    update,
    given(ordinary),
    message(ended),
    model((next) => assert(next).toBe(ordinary)),
  );
  story(
    update,
    given(dragging),
    message(ended),
    model((next) => assert(next).toBe(dragging)),
  );
});

it("a move with no button held ends a drag whose release was missed; the item stops following", () => {
  story(
    update,
    given(ordinary),
    pressed(t9),
    movedTo(120, 100),
    // A quick click: the release came before the page listener started, so it was never heard.
    message(Message.MovedDragPointer({ buttons: 0, pointer: { x: 300, y: 300 }, pointerId })),
    model((next) => {
      assert(next.drag).toEqual(DragState.Idle());
      assert(offsetOf(next.offsets, t9)).toEqual(Option.some({ x: 20, y: 0 }));
    }),
    movedTo(500, 500),
    model((next) => assert(offsetOf(next.offsets, t9)).toEqual(Option.some({ x: 20, y: 0 }))),
  );
});

it("a new primary press ends a drag whose release was missed", () => {
  story(
    update,
    given(dragging),
    message(Message.PressedAfterDrag({ isPrimaryPointer: true })),
    model((next) => assert(next.drag).toEqual(DragState.Idle())),
    // The same press then lands on a grip and starts the next drag.
    pressed(prd),
    model((next) => assert(DragState.guards.Dragging(next.drag)).toBe(true)),
  );
});

it("a press on another grip during a drag is ignored, so a second finger cannot take it over", () => {
  story(
    update,
    given(ordinary),
    pressed(t9),
    message(
      Message.PressedMoveHandle({
        movable: prd,
        pointer: { x: 0, y: 0 },
        pointerId: pointerId + 1,
      }),
    ),
    model((next) =>
      assert(next.drag).toEqual(
        DragState.Dragging({ movable: t9, pointer: { x: 100, y: 100 }, pointerId }),
      ),
    ),
    movedTo(110, 100),
    movedTo(300, 300, pointerId + 1),
    model((next) => {
      assert(offsetOf(next.offsets, t9)).toEqual(Option.some({ x: 10, y: 0 }));
      assert(offsetOf(next.offsets, prd)).toEqual(Option.none());
    }),
  );
});

it("a move after the release moves nothing, and a click on a grip changes nothing", () => {
  story(
    update,
    given(released),
    movedTo(400, 400),
    model((next) => assert(next).toBe(released)),
    message(Message.ClickedMoveHandle()),
    Command.expectNone(),
    model((next) => assert(next).toBe(released)),
  );
});

const arrow = (key: ArrowKey) => message(Message.PressedArrowOnMoveHandle({ key, movable: t9 }));

it("each arrow key nudges the item one step, at any zoom, and the four cancel out", () => {
  story(
    update,
    given(atZoom(0.5)),
    arrow("ArrowRight"),
    model((next) =>
      assert(offsetOf(next.offsets, t9)).toEqual(Option.some({ x: NUDGE_STEP, y: 0 })),
    ),
    arrow("ArrowDown"),
    model((next) =>
      assert(offsetOf(next.offsets, t9)).toEqual(Option.some({ x: NUDGE_STEP, y: NUDGE_STEP })),
    ),
    arrow("ArrowLeft"),
    arrow("ArrowUp"),
    model((next) => assert(offsetOf(next.offsets, t9)).toEqual(Option.some({ x: 0, y: 0 }))),
  );
});

it("reset layout clears every offset", () => {
  story(
    update,
    given(ordinary),
    pressed(t9),
    movedTo(120, 100),
    message(Message.ReleasedDragPointer({ pointerId })),
    message(Message.PressedArrowOnMoveHandle({ key: "ArrowUp", movable: prd })),
    model((next) => assert(Record.size(next.offsets)).toBe(2)),
    message(Message.ClickedResetLayout()),
    Command.expectNone(),
    model((next) => assert(next.offsets).toEqual({})),
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
