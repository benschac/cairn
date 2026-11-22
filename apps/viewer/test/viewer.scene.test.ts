import { ManifestTask, ParticipantId } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Option } from "effect";
import { Subscription, click, expect, given, role, scene, selector, text } from "foldkit/scene";

import { Message, init, update, view } from "../src/main.ts";

const waiting = role("button", { name: "Waiting for approval" });

it("the waiting filter leaves only the tasks that need a human", () => {
  scene(
    { update, view },
    given(init().model),
    expect(text(/Parse PRD sections/u)).toExist(),
    expect(waiting).toHaveAttr("aria-pressed", "false"),
    click(waiting),
    expect(waiting).toHaveAttr("aria-pressed", "true"),
    expect(text(/Add the sessions table/u)).toExist(),
    expect(text(/Parse PRD sections/u)).toBeAbsent(),
    expect(text(/Write the stack/u)).toBeAbsent(),
    click(waiting),
    expect(text(/Write the stack/u)).toExist(),
  );
});

it("other participants appear with their cursors, and you do not", () => {
  scene(
    { update, view },
    given(init().model),
    expect(role("status")).toHaveText("Nobody else is here."),
    Subscription.emit(
      Message.ReceivedPresence({
        presence: {
          participants: [
            {
              cursor: Option.some({ x: 0.1, y: 0.1 }),
              id: ParticipantId.make("p1"),
              kind: "human",
              name: "Ada",
            },
            {
              cursor: Option.some({ x: 0.25, y: 0.5 }),
              id: ParticipantId.make("p2"),
              kind: "agent",
              name: "Planner",
            },
            { cursor: Option.none(), id: ParticipantId.make("p3"), kind: "human", name: "Grace" },
          ],
          you: ParticipantId.make("p1"),
        },
      }),
    ),
    expect(role("status")).toHaveText("Here now: Planner (agent), Grace"),
    expect(selector('[data-cursor="agent"]')).toHaveText("Planner (agent)"),
    expect(selector('[data-cursor="agent"]')).toHaveStyle("left", "25%"),
    expect(selector('[data-cursor="human"]')).toBeAbsent(),
  );
});

it.prop(
  "the waiting filter shows a task only when it is blocked on a human",
  [ManifestTask],
  ([task]) => {
    const row = selector("li");
    scene(
      { update, view },
      given({ ...init().model, rows: [task] }),
      click(waiting),
      task.status === "blocked_on_human" ? expect(row).toExist() : expect(row).toBeAbsent(),
    );
  },
);
