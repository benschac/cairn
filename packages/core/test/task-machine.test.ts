import { Task, TaskEventType, TaskStatus } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { createEffectActor, sendAndAwait } from "@xstate/effect";
import { Array, Effect, Option, Order, Record, Schema } from "effect";
import { initialTransition, transition } from "xstate";
import { getShortestPaths } from "xstate/graph";

import { statusOf, taskMachine } from "../src/index.ts";

const migration = Schema.decodeSync(Task)({
  gated: true,
  id: "task-1",
  section: "prd.data-model",
  title: "Add the sessions table",
});

/** The lifecycle as a table: the status each event leads to. An event missing from a row is ignored. */
const lifecycle = (
  gated: boolean,
): Record.ReadonlyRecord<TaskStatus, Record.ReadonlyRecord<string, TaskStatus>> => ({
  blocked_on_human: { approve: "done" },
  done: { land: "landed" },
  failed: {},
  landed: {},
  pending: { start: "running" },
  running: { finish: gated ? "blocked_on_human" : "done" },
});

it.prop(
  "each status takes the events its lifecycle lists and ignores every other event",
  [Task],
  ([task]) => {
    const table = lifecycle(task.gated);
    for (const { state } of getShortestPaths(taskMachine, { input: task })) {
      const before = statusOf(state);
      for (const type of TaskEventType.literals) {
        const [after] = transition(taskMachine, state, { type });
        const expected = Option.getOrElse(Record.get(table[before], type), () => before);
        expect({ before, type, after: statusOf(after) }).toStrictEqual({
          before,
          type,
          after: expected,
        });
      }
    }
  },
);

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

it("a gated task can reach every status in the contract", () => {
  const reached = Array.map(getShortestPaths(taskMachine, { input: migration }), (path) =>
    statusOf(path.state),
  );
  expect(Array.sort(Array.dedupe(reached), Order.String)).toStrictEqual(
    Array.sort(
      Array.filter(TaskStatus.literals, (status) => status !== "failed"),
      Order.String,
    ),
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
