import { ParticipantId } from "@cairn/contract";
import { assert, it } from "@effect/vitest";
import { Cause, Effect, MutableRef, Option, Queue } from "effect";
import { Mount, Subscription, expect, given, role, scene, selector } from "foldkit/scene";

import { PanZoomCanvas, attachPanZoom, type CanvasMessage } from "../src/canvas.ts";
import type { Viewport } from "../src/geometry.ts";
import { Message } from "../src/message.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import { layerMounted, loaded, mounted } from "./fixtures.ts";

// oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
const failed = Mount.resolve(PanZoomCanvas, Message.FailedPanZoomCanvas({ reason: "no pane" }));

it("a canvas that cannot start pan and zoom says so, and the trace still shows", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(role("alert")).toBeAbsent(),
    Subscription.emit(Message.FailedPanZoomCanvas({ reason: "no pane" })),
    expect(role("alert")).toHaveText("Pan and zoom are unavailable: no pane"),
  );
});

it("the alert is there when the mount itself reports the failure", () => {
  scene(
    { update, view },
    given(loaded),
    failed,
    layerMounted,
    expect(role("alert")).toHaveText("Pan and zoom are unavailable: no pane"),
  );
});

it.effect("a library that throws while starting fails with its message instead of a defect", () =>
  Effect.gen(function* () {
    // Scene tests run without a DOM, so the pane is a stand-in whose first read throws.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- no DOM here, so a stand-in for the Element the mount receives
    const element = {
      getAttribute: () => {
        throw new Error("no viewport");
      },
    } as unknown as Element;
    const queue = yield* Queue.unbounded<CanvasMessage, Cause.Done>();
    const state = {
      isSyncing: MutableRef.make(false),
      reported: MutableRef.make<ReadonlyArray<Viewport>>([]),
    };
    const reason = yield* Effect.flip(Effect.scoped(attachPanZoom(element, queue, state)));
    assert.strictEqual(reason, "no viewport");
  }),
);

it("a closed presence connection says so and drops the stale participants", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    Subscription.emit(Message.OpenedPresence()),
    expect(role("status")).toHaveText("Nobody else is here."),
    Subscription.emit(
      Message.ReceivedPresence({
        presence: {
          participants: [
            {
              cursor: Option.some({ x: 10, y: 20 }),
              id: ParticipantId.make("p2"),
              kind: "agent",
              name: "Planner",
              reading: Option.none(),
            },
          ],
          you: ParticipantId.make("p1"),
        },
      }),
    ),
    expect(role("status")).toHaveText("Here now: Planner (agent)"),
    expect(selector('[data-cursor="agent"]')).toExist(),
    Subscription.emit(Message.ClosedPresence()),
    expect(selector('[data-cursor="agent"]')).toBeAbsent(),
    expect(role("status")).toHaveText(
      "The presence connection is lost. Other participants are not shown.",
    ),
  );
});
