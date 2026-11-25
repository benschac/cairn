import { expect as assert, it } from "@effect/vitest";
import { PrdSectionId } from "@cairn/contract";
import { Option } from "effect";
import {
  Mount,
  Subscription,
  expect,
  expectIgnored,
  given,
  keydown,
  role,
  scene,
  selector,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { update } from "../src/update.ts";
import { pressOnDivider, renderedWidthOf } from "../src/view/dividerView.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { view } from "../src/view/view.ts";
import { loaded, unmeasuredWires } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });

const mountedReader = Mount.resolveAll(
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [ScrollStacksToBottom, Message.CompletedScrollStacks()],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);

const prdDivider = role("separator", { name: "Resize the PRD pane" });
const specDivider = role("separator", { name: "Resize the spec pane" });
const grid = selector("[data-reader-grid]");

const pointerId = 4;
// Scene's pointer steps need a DOM, so a press sends what the divider's handler sends, which is
// tested on its own below; the page's pointer events reach update through a Subscription.
const pressed = (pane: "prd" | "spec" | "detail", x: number, maybeWidth = Option.none<number>()) =>
  Subscription.emit(Message.PressedDivider({ maybeWidth, pane, pointerId, x }));
const movedTo = (x: number, id = pointerId, buttons = 1) =>
  Subscription.emit(Message.MovedResizePointer({ buttons, pointerId: id, x }));
const released = (id = pointerId) =>
  Subscription.emit(Message.ReleasedResizePointer({ pointerId: id }));

it("each divider is a focusable vertical separator that reports its pane's width and limits", () => {
  scene(
    { update, view },
    given(reading),
    mountedReader,
    expect(prdDivider).toHaveAttr("aria-orientation", "vertical"),
    expect(prdDivider).toHaveAttr("tabIndex", "0"),
    expect(prdDivider).toHaveAttr("aria-valuenow", "520"),
    expect(prdDivider).toHaveAttr("aria-valuemin", "300"),
    expect(prdDivider).toHaveAttr("aria-valuemax", "1600"),
    expect(specDivider).toHaveAttr("aria-valuenow", "440"),
    expect(specDivider).toHaveAttr("aria-valuemin", "260"),
    expect(specDivider).toHaveAttr("aria-valuemax", "1600"),
  );
});

it("the grid's columns hold the chosen widths and scroll sideways rather than narrow a pane", () => {
  scene(
    { update, view },
    given(reading),
    mountedReader,
    expect(grid).toHaveStyle("--prd-width", "520px"),
    expect(grid).toHaveStyle("--spec-width", "440px"),
    expect(grid).toHaveStyle(
      "grid-template-columns",
      "var(--prd-width) 76px var(--spec-width) 76px minmax(240px, 1fr)",
    ),
    expect(grid).toHaveStyle("overflow-x", "auto"),
  );
});

it("the arrow keys move a focused divider by 24px, within its limits", () => {
  scene(
    { update, view },
    given(reading),
    mountedReader,
    keydown(prdDivider, "ArrowRight"),
    expect(prdDivider).toHaveAttr("aria-valuenow", "544"),
    keydown(prdDivider, "ArrowLeft"),
    keydown(prdDivider, "ArrowLeft"),
    expect(prdDivider).toHaveAttr("aria-valuenow", "496"),
    expect(specDivider).toHaveAttr("aria-valuenow", "440"),
    keydown(prdDivider, "Enter"),
    expectIgnored(),
    expect(prdDivider).toHaveAttr("aria-valuenow", "496"),
  );
});

it("pressing, moving and releasing sets the width to its width at the press plus the travel", () => {
  scene(
    { update, view },
    given(reading),
    mountedReader,
    pressed("spec", 700),
    expect(grid).toHaveStyle("user-select", "none"),
    movedTo(760),
    expect(specDivider).toHaveAttr("aria-valuenow", "500"),
    movedTo(650),
    expect(specDivider).toHaveAttr("aria-valuenow", "390"),
    released(),
    expect(grid).toHaveStyle("user-select", "auto"),
    movedTo(900),
    expect(specDivider).toHaveAttr("aria-valuenow", "390"),
    expect(prdDivider).toHaveAttr("aria-valuenow", "520"),
  );
});

it("a drag stops at the pane's limits", () => {
  scene(
    { update, view },
    given(reading),
    mountedReader,
    pressed("prd", 0),
    movedTo(5000),
    expect(prdDivider).toHaveAttr("aria-valuenow", "1600"),
    movedTo(-5000),
    expect(prdDivider).toHaveAttr("aria-valuenow", "300"),
  );
});

it("a move or release from another pointer changes nothing", () => {
  scene(
    { update, view },
    given(reading),
    mountedReader,
    pressed("prd", 100),
    movedTo(300, pointerId + 1),
    expect(prdDivider).toHaveAttr("aria-valuenow", "520"),
    released(pointerId + 1),
    movedTo(130),
    expect(prdDivider).toHaveAttr("aria-valuenow", "550"),
  );
});

it("a move with no button held ends a resize whose release was missed", () => {
  scene(
    { update, view },
    given(reading),
    mountedReader,
    pressed("prd", 100),
    movedTo(130, pointerId, 0),
    expect(prdDivider).toHaveAttr("aria-valuenow", "520"),
    movedTo(200),
    expect(prdDivider).toHaveAttr("aria-valuenow", "520"),
  );
});

it("a second press while one resize is going on is ignored", () => {
  scene(
    { update, view },
    given(reading),
    mountedReader,
    pressed("prd", 100),
    Subscription.emit(
      Message.PressedDivider({
        maybeWidth: Option.none(),
        pane: "spec",
        pointerId: pointerId + 1,
        x: 9,
      }),
    ),
    movedTo(130),
    expect(prdDivider).toHaveAttr("aria-valuenow", "550"),
    expect(specDivider).toHaveAttr("aria-valuenow", "440"),
  );
});

it("only the primary button presses a divider", () => {
  const press = pressOnDivider("prd");
  assert(press("mouse", 0, 0, 0, 0, 33, 0, 9, null)).toEqual(
    Option.some(
      Message.PressedDivider({ maybeWidth: Option.none(), pane: "prd", pointerId: 9, x: 33 }),
    ),
  );
  assert(press("mouse", 2, 0, 0, 0, 33, 0, 9, null)).toEqual(Option.none());
});

const boxOf = (width: number) => ({ getBoundingClientRect: () => ({ width }) });

it("a press carries the rendered width of the pane beside the divider, and of the panel around the detail divider", () => {
  const beside = { previousElementSibling: boxOf(312) };
  const inside = { closest: () => boxOf(480) };
  assert(renderedWidthOf("prd", beside)).toEqual(Option.some(312));
  assert(renderedWidthOf("spec", beside)).toEqual(Option.some(312));
  assert(renderedWidthOf("detail", inside)).toEqual(Option.some(480));
  assert(renderedWidthOf("prd", inside)).toEqual(Option.none());
  assert(renderedWidthOf("detail", beside)).toEqual(Option.none());
  assert(renderedWidthOf("prd", null)).toEqual(Option.none());
});

it("a drag starts from the rendered width when the grid holds the pane below the chosen one", () => {
  scene(
    { update, view },
    given(reading),
    mountedReader,
    expect(prdDivider).toHaveAttr("aria-valuenow", "520"),
    pressed("prd", 100, Option.some(300)),
    movedTo(130),
    // 300 rendered plus 30 of travel, not the chosen 520 plus 30.
    expect(prdDivider).toHaveAttr("aria-valuenow", "330"),
    movedTo(90),
    expect(prdDivider).toHaveAttr("aria-valuenow", "300"),
    released(),
  );
});
