import { ParticipantId, PrdSectionId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option } from "effect";
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

import { Message } from "../src/message.ts";
import { Screen, type Model } from "../src/model.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { view } from "../src/view/view.ts";
import { loaded, sequence, unmeasuredWires } from "./fixtures.ts";

/** The reader open on the demo trace. */
const reader = modifyFields(loaded, { screen: () => Screen.Reader() });

const goal = PrdSectionId.make("prd.goal");
const viewer = PrdSectionId.make("prd.viewer");

const participant = (
  id: string,
  kind: "agent" | "human",
  name: string,
  reading: Option.Option<PrdSectionId>,
) => ({ id: ParticipantId.make(id), kind, name, reading });

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

/** The room with Planner reading `section`, as the server sends it again after any change. */
const roomAt = (section: PrdSectionId) =>
  roomWith(
    participant("p2", "agent", "Planner", Option.some(section)),
    participant("p3", "human", "Grace", Option.none()),
  );

const afterRoom = (model: Model, message: Message) => {
  return update(model, message).model;
};

it("a room that repeats who reads what rebuilds nothing in the PRD body, and a changed reading does", () => {
  const first = afterRoom(reader, roomAt(viewer));
  const repeated = afterRoom(first, roomAt(viewer));
  const read = afterRoom(first, roomAt(goal));
  // The room's participants are new values each frame, but who reads what is kept as it was.
  assert(repeated.participants).not.toBe(first.participants);
  assert(repeated.readers).toBe(first.readers);
  assert(() =>
    Lazy.expectAllReused({ model: first, view: sequence([first, repeated]) }),
  ).not.toThrow();
  assert(() => Lazy.expectAllReused({ model: first, view: sequence([first, read]) })).toThrow(
    "1 lazy cache miss on the second render",
  );
});

it("a chip stays through a repeated room and follows a changed reading", () => {
  scene(
    { update, view },
    given(reader),
    mountedReader,
    Subscription.emit(roomAt(viewer)),
    expect(chipsAt(viewer)).toHaveText("Planner (agent)"),
    Subscription.emit(roomAt(viewer)),
    expect(chipsAt(viewer)).toHaveText("Planner (agent)"),
    chipCount(viewer).toHaveCount(1),
    Subscription.emit(roomAt(goal)),
    chipCount(viewer).toHaveCount(0),
    expect(chipsAt(goal)).toHaveText("Planner (agent)"),
  );
});
