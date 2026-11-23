import { TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Option } from "effect";
import {
  Mount,
  Subscription,
  all,
  click,
  expect,
  expectAll,
  expectIgnored,
  given,
  keydown,
  role,
  scene,
  selector,
  within,
} from "foldkit/scene";

import { PanZoomCanvas } from "../src/canvas.ts";
import { demoTrace } from "../src/demo.ts";
import { Movable, OFFSETS_ATTRIBUTE, offsetsAttribute } from "../src/drag.ts";
import { Message } from "../src/message.ts";
import { update } from "../src/update.ts";
import { pressOnGrip } from "../src/view/moveHandleView.ts";
import { view } from "../src/view/view.ts";
import { layerMounted, loaded, mounted } from "./fixtures.ts";

const card = selector('[data-task="t9"]');
const cardGrip = within(card, role("button", { name: "Move t9" }));
const prdColumn = selector('[data-column="prd"]');
const prdGrip = within(role("region", { name: "PRD" }), role("button", { name: "Move PRD" }));
const specGrip = within(role("region", { name: "Spec" }), role("button", { name: "Move Spec" }));
const layer = selector("[data-canvas-layer]");
const resetLayout = role("button", { name: "Reset layout" });

const pointerId = 7;
const t9 = Movable.Task({ id: TaskId.make("t9") });
const prd = Movable.Document({ document: "prd" });
// Scene's pointerDown step needs a DOM, which these tests run without, so a press sends what the
// grip's handler sends; `pressOnGrip` is tested on its own below.
const pressed = (movable: Movable, x: number, y: number) =>
  Subscription.emit(Message.PressedMoveHandle({ movable, pointer: { x, y }, pointerId }));
// The page's pointer events reach update through the drag Subscription, which Scene does not run.
const movedTo = (x: number, y: number) =>
  Subscription.emit(Message.MovedDragPointer({ buttons: 1, pointer: { x, y }, pointerId }));
const released = Subscription.emit(Message.ReleasedDragPointer({ pointerId }));
/** The canvas pane's mount reporting a viewport at `zoom`, and the layer's mount measuring nothing. */
const zoomedTo = (zoom: number) => [
  Mount.resolve(PanZoomCanvas, Message.PannedOrZoomed({ viewport: { x: 0, y: 0, zoom } })),
  layerMounted,
];

it("the layer is marked as dragging while a drag is in progress, and not after it", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(selector("[data-canvas-layer][data-dragging]")).toBeAbsent(),
    pressed(t9, 100, 100),
    expect(layer).toHaveAttr("data-dragging", ""),
    expect(layer).toHaveStyle("cursor", "grabbing"),
    released,
    expect(selector("[data-canvas-layer][data-dragging]")).toBeAbsent(),
  );
});

it("each document and each task card has a labelled grip button that does not pan", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(prdGrip).toHaveAttr("type", "button"),
    expect(prdGrip).toHaveClass("nopan"),
    expect(specGrip).toHaveAttr("type", "button"),
    expect(cardGrip).toHaveAttr("type", "button"),
    expect(cardGrip).toHaveClass("nopan"),
    expectAll(all.selector("[data-move-handle]")).toHaveCount(2 + demoTrace.tasks.length),
  );
});

it("dragging a card's grip moves the card by the pointer's move over the zoom", () => {
  scene(
    { update, view },
    given(loaded),
    ...zoomedTo(2),
    expect(card).not.toHaveStyle("transform"),
    pressed(t9, 100, 100),
    expect(layer).toHaveStyle("user-select", "none"),
    movedTo(140, 80),
    expect(card).toHaveStyle("transform", "translate(20px, -10px)"),
    // The card keeps its own style beside the move.
    expect(card).toHaveStyle("border", "1px solid #94a3b8"),
    expect(selector('[data-task="t1"]')).not.toHaveStyle("transform"),
    expect(prdColumn).not.toHaveStyle("transform"),
    released,
    expect(layer).not.toHaveStyle("user-select"),
    movedTo(400, 400),
    expect(card).toHaveStyle("transform", "translate(20px, -10px)"),
  );
});

it("dragging the PRD's grip moves the whole column, and its sections with it", () => {
  scene(
    { update, view },
    given(loaded),
    ...zoomedTo(0.5),
    pressed(prd, 10, 10),
    movedTo(20, 15),
    released,
    expect(prdColumn).toHaveStyle("transform", "translate(20px, 10px)"),
    expect(selector('[data-column="prd"] [data-section]')).not.toHaveStyle("transform"),
    expect(selector('[data-column="spec"]')).not.toHaveStyle("transform"),
  );
});

it("the layer carries every offset, so the layout mount measures the moved positions", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(layer).toHaveAttr(OFFSETS_ATTRIBUTE, offsetsAttribute({})),
    pressed(t9, 0, 0),
    movedTo(5, 6),
    expect(layer).toHaveAttr(OFFSETS_ATTRIBUTE, offsetsAttribute({ "task:t9": { x: 5, y: 6 } })),
  );
});

it("a press on a grip with the primary button starts a drag there, and no other button does", () => {
  const press = pressOnGrip(t9);
  assert(press("mouse", 0, 0, 0, 0, 30, 40, pointerId)).toEqual(
    Option.some(Message.PressedMoveHandle({ movable: t9, pointer: { x: 30, y: 40 }, pointerId })),
  );
  assert(press("touch", 0, 0, 0, 0, 1, 2, pointerId)).toEqual(
    Option.some(Message.PressedMoveHandle({ movable: t9, pointer: { x: 1, y: 2 }, pointerId })),
  );
  assert(press("mouse", 1, 0, 0, 0, 30, 40, pointerId)).toEqual(Option.none());
  assert(press("mouse", 2, 0, 0, 0, 30, 40, pointerId)).toEqual(Option.none());
});

it("the arrow keys on a grip nudge its item, and other keys do nothing", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    keydown(cardGrip, "Enter"),
    expectIgnored(),
    expect(card).not.toHaveStyle("transform"),
    keydown(cardGrip, "ArrowRight"),
    keydown(cardGrip, "ArrowDown"),
    keydown(cardGrip, "ArrowDown"),
    expect(card).toHaveStyle("transform", "translate(10px, 20px)"),
    keydown(specGrip, "ArrowLeft"),
    expect(selector('[data-column="spec"]')).toHaveStyle("transform", "translate(-10px, 0px)"),
  );
});

it("a click on a grip stops there: it opens no drawer and presses no node", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    click(cardGrip),
    click(prdGrip),
    expectAll(all.role("button", { pressed: true })).toBeEmpty(),
    expect(selector("[data-drawer]")).toBeAbsent(),
    expect(card).not.toHaveStyle("transform"),
  );
});

it("Reset layout puts every moved document and card back", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    keydown(cardGrip, "ArrowRight"),
    keydown(prdGrip, "ArrowUp"),
    expect(card).toHaveStyle("transform"),
    expect(prdColumn).toHaveStyle("transform"),
    click(resetLayout),
    expect(card).not.toHaveStyle("transform"),
    expect(prdColumn).not.toHaveStyle("transform"),
    expect(layer).toHaveAttr(OFFSETS_ATTRIBUTE, offsetsAttribute({})),
  );
});
