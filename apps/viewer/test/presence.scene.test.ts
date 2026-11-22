import { Cursor, ParticipantId } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { Mount, Subscription, expect, given, role, scene, selector } from "foldkit/scene";

import { PanZoomCanvas, transformOf } from "../src/canvas.ts";
import { Viewport } from "../src/geometry.ts";
import { Message } from "../src/message.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import { layerMounted, loaded, paneSize } from "./fixtures.ts";

const presenceWith = (agentCursor: Cursor) =>
  Message.ReceivedPresence({
    presence: {
      participants: [
        {
          cursor: Option.some({ x: 10, y: 20 }),
          id: ParticipantId.make("p1"),
          kind: "human",
          name: "Ada",
        },
        {
          cursor: Option.some(agentCursor),
          id: ParticipantId.make("p2"),
          kind: "agent",
          name: "Planner",
        },
        { cursor: Option.none(), id: ParticipantId.make("p3"), kind: "human", name: "Grace" },
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
