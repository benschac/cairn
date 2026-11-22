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
    const steps = Array.map(
      Array.cartesian(getShortestPaths(taskMachine, { input: task }), TaskEventType.literals),
      ([{ state }, type]) => ({
        before: statusOf(state),
        type,
        after: statusOf(transition(taskMachine, state, { type })[0]),
      }),
    );
    expect(steps).toStrictEqual(
      Array.map(steps, ({ before, type }) => ({
        before,
        type,
        after: Option.getOrElse(Record.get(table[before], type), () => before),
      })),
    );
  },
);

it.prop(
  "a gated task is done only after a human approves it",
  [Task, Schema.Array(TaskEventType)],
  ([task, events]) => {
    Array.reduce(events, initialTransition(taskMachine, task)[0], (snapshot, type) => {
      const before = statusOf(snapshot);
      const [next] = transition(taskMachine, snapshot, { type });
      const after = statusOf(next);
      if (task.gated && after === "done" && before !== "done") {
        expect([before, type]).toStrictEqual(["blocked_on_human", "approve"]);
      }
      return next;
    });
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
