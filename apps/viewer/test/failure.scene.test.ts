import { ParticipantId } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Option } from "effect";
import { Subscription, expect, given, role, scene } from "foldkit/scene";

import { Message } from "../src/message.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import { loaded, mounted } from "./fixtures.ts";

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
    Subscription.emit(Message.ClosedPresence()),
    expect(role("status")).toHaveText(
      "The presence connection is lost. Other participants are not shown.",
    ),
  );
});
