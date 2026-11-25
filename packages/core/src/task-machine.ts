import { ManifestTask, TaskEvents } from "@cairn/contract";
import type { TaskStatus } from "@cairn/contract";
import { setupEffect } from "@xstate/effect";
import { Schema } from "effect";
import type { SnapshotFrom } from "xstate";

/**
 * What the machine runs on: the manifest task and its effective gate. The gate is the
 * task's own `humanGate.required` or a path or tag the config adds, so the caller works it
 * out (see spec.gates.detection) and the machine only obeys it.
 */
export const TaskInput = Schema.Struct({
  gated: Schema.Boolean,
  task: Schema.toType(ManifestTask),
});
export type TaskInput = typeof TaskInput.Type;

export const taskMachine = setupEffect({
  schemas: {
    context: TaskInput,
    events: TaskEvents,
    input: TaskInput,
  },
}).createMachine({
  context: ({ input }) => input,
  id: "task",
  initial: "pending",
  states: {
    blocked_on_human: {
      on: { approve: { target: "done" }, land: { target: "landed" } },
    },
    done: {
      on: { land: { target: "landed" } },
    },
    failed: {
      on: { land: { target: "landed" }, start: { target: "running" } },
    },
    landed: { type: "final" },
    pending: {
      on: { land: { target: "landed" }, start: { target: "running" } },
    },
    running: {
      on: {
        fail: { target: "failed" },
        finish: ({ context }) => ({
          target: context.gated ? "blocked_on_human" : "done",
        }),
        land: { target: "landed" },
      },
    },
  },
});

export const statusOf = (snapshot: SnapshotFrom<typeof taskMachine>): TaskStatus => snapshot.value;
