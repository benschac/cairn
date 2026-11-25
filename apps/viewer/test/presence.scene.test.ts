import { Cursor, ParticipantId, PrdSectionId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Schema } from "effect";
import { Lazy } from "foldkit/test";
import { modifyFields } from "foldkit/struct";
import {
  Mount,
  Subscription,
  all,
  expect,
  expectAll,
  given,
  role,
  scene,
  selector,
} from "foldkit/scene";

import { PanZoomCanvas, transformOf } from "../src/canvas.ts";
import { Viewport } from "../src/geometry.ts";
import { Message } from "../src/message.ts";
import { Screen, type Model } from "../src/model.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { view } from "../src/view/view.ts";
import { layerMounted, loaded, paneSize, sequence, unmeasuredWires } from "./fixtures.ts";

const presenceWith = (agentCursor: Cursor) =>
  Message.ReceivedPresence({
    presence: {
      participants: [
        {
          cursor: Option.some({ x: 10, y: 20 }),
          id: ParticipantId.make("p1"),
          kind: "human",
          name: "Ada",
          reading: Option.none(),
        },
        {
          cursor: Option.some(agentCursor),
          id: ParticipantId.make("p2"),
          kind: "agent",
          name: "Planner",
          reading: Option.none(),
        },
        {
          cursor: Option.none(),
          id: ParticipantId.make("p3"),
          kind: "human",
          name: "Grace",
          reading: Option.none(),
        },
      ],
      you: ParticipantId.make("p1"),
    },
  });

const agentCursor = selector('[data-canvas-layer] [data-cursor="agent"]');

it("other participants appear with their cursors, and you do not", () => {
  scene(
    { update, view },
    given(loaded),
    layerMounted,
    Mount.resolve(PanZoomCanvas, Message.MeasuredPane({ size: paneSize })),
    expect(role("status")).toHaveText("Nobody else is here."),
    Subscription.emit(presenceWith({ x: 300, y: -40 })),
    expect(role("status")).toHaveText("Here now: Planner (agent), Grace"),
    expect(agentCursor).toHaveText("Planner (agent)"),
    // The status line names everyone, so the cursor's label is hidden from assistive tech.
    expect(agentCursor).toHaveAttr("aria-hidden", "true"),
    expect(selector('[data-cursor="human"]')).toBeAbsent(),
  );
});

// Whole pixels, so the style the view writes reads back as the same text.
const Pixel = Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: -10_000 }));
const LayerPoint = Cursor.mapFields(() => ({ x: Pixel, y: Pixel }));

it.prop(
  "a cursor sits at its canvas position inside the layer, whatever the viewport",
  { cursor: LayerPoint, viewport: Viewport },
  ({ cursor, viewport }) => {
    scene(
      { update, view },
      given(loaded),
      layerMounted,
      Mount.resolve(PanZoomCanvas, Message.PannedOrZoomed({ viewport })),
      Subscription.emit(presenceWith(cursor)),
      expect(agentCursor).toHaveStyle("left", `${cursor.x}px`),
      expect(agentCursor).toHaveStyle("top", `${cursor.y}px`),
      expect(agentCursor).toHaveStyle("transform", `scale(${1 / viewport.zoom})`),
      expect(selector("[data-canvas-layer]")).toHaveStyle("transform", transformOf(viewport)),
    );
  },
  // Each run renders the whole demo trace, so a few runs cover it.
  { arbitrary: { runs: 10 }, timeout: 30_000 },
);

/** The reader open on the demo trace, as the Plan button leaves it. */
const reader = modifyFields(loaded, { screen: () => Screen.Reader() });

const goal = PrdSectionId.make("prd.goal");
const viewer = PrdSectionId.make("prd.viewer");

const participant = (
  id: string,
  kind: "agent" | "human",
  name: string,
  reading: Option.Option<PrdSectionId>,
  cursor: Option.Option<Cursor> = Option.none(),
) => ({ cursor, id: ParticipantId.make(id), kind, name, reading });

/** A room as the server sends it to p1, who is Ada. */
const roomWith = (...others: ReadonlyArray<ReturnType<typeof participant>>) =>
  Message.ReceivedPresence({
    presence: {
      participants: Array.prepend(others, participant("p1", "human", "Ada", Option.some(goal))),
      you: ParticipantId.make("p1"),
    },
  });

const mountedReader = Mount.resolveAll(
  [TrackPrdScroll, Message.ScrolledPrd({ id: goal })],
  [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);

/** The chips beside a PRD heading, one for each other participant reading that section. */
const chipsAt = (id: string) => selector(`[data-prd-pane] [data-section="${id}"] [data-reading]`);

const chipCount = (id: string) =>
  expectAll(all.selector(`[data-prd-pane] [data-section="${id}"] [data-reading]`));

it("each other participant's label shows beside the heading they are reading, and moves with them", () => {
  scene(
    { update, view },
    given(reader),
    mountedReader,
    chipCount(goal).toHaveCount(0),
    Subscription.emit(
      roomWith(
        participant("p2", "agent", "Planner", Option.some(goal)),
        participant("p3", "human", "Grace", Option.some(viewer)),
        participant("p4", "human", "Lin", Option.none()),
      ),
    ),
    // Ada is you and is reading prd.goal too, so you get no chip for yourself.
    expect(chipsAt(goal)).toHaveText("Planner (agent)"),
    chipCount(goal).toHaveCount(1),
    expect(chipsAt(viewer)).toHaveText("Grace"),
    chipCount(viewer).toHaveCount(1),
    expect(role("status")).toHaveText("Here now: Planner (agent), Grace, Lin"),
    Subscription.emit(
      roomWith(
        participant("p2", "agent", "Planner", Option.some(viewer)),
        participant("p3", "human", "Grace", Option.some(viewer)),
      ),
    ),
    chipCount(goal).toHaveCount(0),
    chipCount(viewer).toHaveCount(2),
  );
});

it("two participants on one section show two chips, each with its own label", () => {
  scene(
    { update, view },
    given(reader),
    mountedReader,
    Subscription.emit(
      roomWith(
        participant("p2", "human", "Grace", Option.some(viewer)),
        participant("p3", "agent", "Planner", Option.some(viewer)),
      ),
    ),
    chipCount(viewer).toHaveCount(2),
    expect(selector('[data-prd-pane] [data-reading="p2"]')).toHaveText("Grace"),
    expect(selector('[data-prd-pane] [data-reading="p3"]')).toHaveText("Planner (agent)"),
    chipCount(goal).toHaveCount(0),
  );
});

/** The room with a pointer somewhere: Planner reads `section`, and every cursor is at `x`. */
const roomAt = (x: number, section: PrdSectionId) => {
  const cursor = Option.some({ x, y: x });
  return roomWith(
    participant("p2", "agent", "Planner", Option.some(section), cursor),
    participant("p3", "human", "Grace", Option.none(), cursor),
  );
};

const afterRoom = (model: Model, message: Message) => {
  return update(model, message).model;
};

it("a pointer that only moves rebuilds nothing in the PRD body, and a changed reading does", () => {
  const first = afterRoom(reader, roomAt(1, viewer));
  const moved = afterRoom(first, roomAt(2, viewer));
  const read = afterRoom(first, roomAt(1, goal));
  // The room's participants are new values each frame, but who reads what is kept as it was.
  assert(moved.participants).not.toBe(first.participants);
  assert(moved.readers).toBe(first.readers);
  assert(() =>
    Lazy.expectAllReused({ model: first, view: sequence([first, moved]) }),
  ).not.toThrow();
  assert(() => Lazy.expectAllReused({ model: first, view: sequence([first, read]) })).toThrow(
    "1 lazy cache miss on the second render",
  );
});

it("a chip stays through cursor-only presence and follows a changed reading", () => {
  scene(
    { update, view },
    given(reader),
    mountedReader,
    Subscription.emit(roomAt(1, viewer)),
    expect(chipsAt(viewer)).toHaveText("Planner (agent)"),
    Subscription.emit(roomAt(2, viewer)),
    expect(chipsAt(viewer)).toHaveText("Planner (agent)"),
    chipCount(viewer).toHaveCount(1),
    Subscription.emit(roomAt(3, goal)),
    chipCount(viewer).toHaveCount(0),
    expect(chipsAt(goal)).toHaveText("Planner (agent)"),
  );
});
