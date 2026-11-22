import { Task, TaskEventType, TaskStatus } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { createEffectActor, sendAndAwait } from "@xstate/effect";
import { Effect, Schema } from "effect";
import { initialTransition, transition } from "xstate";
import { getShortestPaths } from "xstate/graph";

import { statusOf, taskMachine } from "../src/index.ts";

const decodeTask = Schema.decodeUnknownSync(Task);

const migration = decodeTask({
  gated: true,
  id: "task-1",
  section: "prd.data-model",
  title: "Add the sessions table",
});

it.prop(
  "a gated task is done only after a human approves it",
  [Task, Schema.Array(TaskEventType)],
  ([task, events]) => {
    let [snapshot] = initialTransition(taskMachine, task);
    for (const type of events) {
      const before = statusOf(snapshot);
      [snapshot] = transition(taskMachine, snapshot, { type });
      const after = statusOf(snapshot);
      if (task.gated && after === "done" && before !== "done") {
        expect([before, type]).toStrictEqual(["blocked_on_human", "approve"]);
      }
    }
  },
);

it.prop(
  "an ungated task never waits for a human",
  [Task, Schema.Array(TaskEventType)],
  ([task, events]) => {
    let [snapshot] = initialTransition(taskMachine, { ...task, gated: false });
    for (const type of events) {
      [snapshot] = transition(taskMachine, snapshot, { type });
      expect(statusOf(snapshot)).not.toBe("blocked_on_human");
    }
  },
);

it("a gated task can reach every status in the contract", () => {
  const reached = getShortestPaths(taskMachine, { input: migration }).map((path) =>
    statusOf(path.state),
  );
  expect(new Set(reached)).toStrictEqual(
    new Set(TaskStatus.literals.filter((status) => status !== "failed")),
  );
});

it.effect("a running actor holds a migration until it is approved", () =>
  Effect.gen(function* () {
    const actor = yield* createEffectActor(taskMachine, { input: migration });
    yield* sendAndAwait(actor, { type: "start" });
    const finished = yield* sendAndAwait(actor, { type: "finish" });
    expect(statusOf(finished)).toBe("blocked_on_human");
    const landedEarly = yield* sendAndAwait(actor, { type: "land" });
    expect(statusOf(landedEarly)).toBe("blocked_on_human");
    const approved = yield* sendAndAwait(actor, { type: "approve" });
    expect(statusOf(approved)).toBe("done");
  }),
);
