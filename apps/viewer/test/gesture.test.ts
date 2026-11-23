import { expect as assert, it } from "@effect/vitest";
import { Array, Schema } from "effect";

import { GestureEvent, PointerId, gestureStep } from "../src/drag.ts";

/** Runs page events through the step from disarmed, and says which clicks it stopped. */
const stoppedClicks = (dragPointerId: number, events: ReadonlyArray<GestureEvent>) =>
  Array.reduce(events, { isArmed: false, stopped: Array.empty<boolean>() }, (state, event) => {
    const next = gestureStep(dragPointerId, state.isArmed, event);
    return {
      isArmed: next.isArmed,
      stopped: GestureEvent.guards.Clicked(event)
        ? Array.append(state.stopped, next.stopsClick)
        : state.stopped,
    };
  }).stopped;

const drag = 3;
const up = (pointerId: number) => GestureEvent.PointerUp({ pointerId });
const click = GestureEvent.Clicked();
const press = GestureEvent.Pressed();

it("the drag's pointer going up stops the one click that follows, and no other", () => {
  assert(stoppedClicks(drag, [up(drag), click, click])).toEqual([true, false]);
});

it.prop(
  "another pointer going up never stops a click, so a second finger's tap reaches its node",
  { other: PointerId.check(Schema.isGreaterThan(drag)) },
  ({ other }) => {
    assert(stoppedClicks(drag, [up(other), click])).toEqual([false]);
  },
);

it("a press after the release disarms, so a release that made no click swallows nothing", () => {
  assert(stoppedClicks(drag, [up(drag), press, click])).toEqual([false]);
});

it("a click with nothing released passes", () => {
  assert(stoppedClicks(drag, [click])).toEqual([false]);
});
