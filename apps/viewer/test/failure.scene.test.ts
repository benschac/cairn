import { ParticipantId } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { Message } from "../src/message.ts";
import { update } from "../src/update.ts";
import { byRole, loaded, readerMounted, viewerScene } from "./fixtures.ts";

it.effect("a closed presence connection says so and drops the stale participants", () =>
  Effect.gen(function* () {
    // The presence socket is a page subscription the scene does not hear, so each Message is
    // applied with `update` and the scene is given the Model it leaves.
    const opened = update(loaded, Message.OpenedPresence()).model;
    const received = update(
      opened,
      Message.ReceivedPresence({
        presence: {
          participants: [
            {
              id: ParticipantId.make("p2"),
              kind: "agent",
              name: "Planner",
              reading: Option.none(),
            },
          ],
          you: ParticipantId.make("p1"),
        },
      }),
    ).model;
    const closed = update(received, Message.ClosedPresence()).model;
    const s = yield* viewerScene(loaded);
    // A given Model draws the reader afresh, so its mounts start again.
    s.pipe(readerMounted)
      .given(opened)
      .pipe(readerMounted)
      .expect(byRole("status"))
      .toHaveText("Nobody else is here.")
      .given(received)
      .pipe(readerMounted)
      .expect(byRole("status"))
      .toHaveText("Here now: Planner (agent)")
      .given(closed)
      .pipe(readerMounted)
      .expect(byRole("status"))
      .toHaveText("The presence connection is lost. Other participants are not shown.");
  }),
);
