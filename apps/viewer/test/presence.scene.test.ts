import { UiStruct } from "@effect/ui";
import { ParticipantId, PrdSectionId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option } from "effect";

import { Message } from "../src/message.ts";
import { Screen, type Model } from "../src/model.ts";
import { update } from "../src/update.ts";
import {
  byRole,
  data,
  inside,
  loaded,
  readerMounted,
  viewerScene,
  type ViewerSteps,
} from "./fixtures.ts";

/** The reader open on the demo trace. */
const reader = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });

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

/** The chips beside a PRD heading, one for each other participant reading that section. */
const chipsAt = (id: string) =>
  inside(inside(data("prd-pane"), data("section", id)), data("reading"));

/** The presence socket is a page subscription the scene does not hear: a room is the Model `update` makes of it. */
const afterRoom = (model: Model, message: Message) => update(model, message).model;

/** A room arriving draws the reader afresh, so its mounts start again. */
const room = (model: Model) => (s: ViewerSteps) => s.given(model).pipe(readerMounted);

it.effect(
  "each other participant's label shows beside the heading they are reading, and moves with them",
  () =>
    Effect.gen(function* () {
      const first = afterRoom(
        reader,
        roomWith(
          participant("p2", "agent", "Planner", Option.some(goal)),
          participant("p3", "human", "Grace", Option.some(viewer)),
          participant("p4", "human", "Lin", Option.none()),
        ),
      );
      const second = afterRoom(
        first,
        roomWith(
          participant("p2", "agent", "Planner", Option.some(viewer)),
          participant("p3", "human", "Grace", Option.some(viewer)),
        ),
      );
      const s = yield* viewerScene(reader);
      s.pipe(readerMounted)
        .expect(chipsAt(goal))
        .toHaveCount(0)
        .pipe(room(first))
        // Ada is you and is reading prd.goal too, so you get no chip for yourself.
        .expect(chipsAt(goal))
        .toHaveText("Planner (agent)")
        .expect(chipsAt(goal))
        .toHaveCount(1)
        .expect(chipsAt(viewer))
        .toHaveText("Grace")
        .expect(chipsAt(viewer))
        .toHaveCount(1)
        .expect(byRole("status"))
        .toHaveText("Here now: Planner (agent), Grace, Lin")
        .pipe(room(second))
        .expect(chipsAt(goal))
        .toHaveCount(0)
        .expect(chipsAt(viewer))
        .toHaveCount(2);
    }),
);

it.effect("two participants on one section show two chips, each with its own label", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reader);
    s.pipe(
      readerMounted,
      room(
        afterRoom(
          reader,
          roomWith(
            participant("p2", "human", "Grace", Option.some(viewer)),
            participant("p3", "agent", "Planner", Option.some(viewer)),
          ),
        ),
      ),
    )
      .expect(chipsAt(viewer))
      .toHaveCount(2)
      .expect(inside(data("prd-pane"), data("reading", "p2")))
      .toHaveText("Grace")
      .expect(inside(data("prd-pane"), data("reading", "p3")))
      .toHaveText("Planner (agent)")
      .expect(chipsAt(goal))
      .toHaveCount(0);
  }),
);

/** The room with Planner reading `section`, as the server sends it again after any change. */
const roomAt = (section: PrdSectionId) =>
  roomWith(
    participant("p2", "agent", "Planner", Option.some(section)),
    participant("p3", "human", "Grace", Option.none()),
  );

// The Foldkit view's `Lazy.expectAllReused` has no Effect UI equivalent. The model keeps who reads
// what by reference across a repeated room, which is what the cached body keyed on, and the drawn
// chips are the same after a repeated room and move after a changed reading.
it.effect(
  "a room that repeats who reads what rebuilds nothing in the PRD body, and a changed reading does",
  () =>
    Effect.gen(function* () {
      const first = afterRoom(reader, roomAt(viewer));
      const repeated = afterRoom(first, roomAt(viewer));
      const read = afterRoom(first, roomAt(goal));
      // The room's participants are new values each frame, but who reads what is kept as it was.
      assert(repeated.participants).not.toBe(first.participants);
      assert(repeated.readers).toBe(first.readers);
      assert(read.readers).not.toBe(first.readers);
      const s = yield* viewerScene(first);
      s.pipe(readerMounted)
        .expect(chipsAt(viewer))
        .toHaveText("Planner (agent)")
        .pipe(room(repeated))
        .expect(chipsAt(viewer))
        .toHaveText("Planner (agent)")
        .pipe(room(read))
        .expect(chipsAt(viewer))
        .toHaveCount(0)
        .expect(chipsAt(goal))
        .toHaveText("Planner (agent)");
    }),
);

it.effect("a chip stays through a repeated room and follows a changed reading", () =>
  Effect.gen(function* () {
    const first = afterRoom(reader, roomAt(viewer));
    const s = yield* viewerScene(reader);
    s.pipe(readerMounted, room(first))
      .expect(chipsAt(viewer))
      .toHaveText("Planner (agent)")
      .pipe(room(afterRoom(first, roomAt(viewer))))
      .expect(chipsAt(viewer))
      .toHaveText("Planner (agent)")
      .expect(chipsAt(viewer))
      .toHaveCount(1)
      .pipe(room(afterRoom(first, roomAt(goal))))
      .expect(chipsAt(viewer))
      .toHaveCount(0)
      .expect(chipsAt(goal))
      .toHaveText("Planner (agent)");
  }),
);
