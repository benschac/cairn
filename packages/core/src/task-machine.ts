import { Task, TaskEvents } from "@cairn/contract";
import type { TaskStatus } from "@cairn/contract";
import { setupEffect } from "@xstate/effect";
import { Schema } from "effect";
import type { SnapshotFrom } from "xstate";

const DecodedTask = Schema.toType(Task);

export const taskMachine = setupEffect({
  schemas: {
    context: DecodedTask,
    events: TaskEvents,
    input: DecodedTask,
  },
}).createMachine({
  context: ({ input }) => input,
  id: "task",
  initial: "pending",
  states: {
    blocked_on_human: {
      on: { approve: { target: "done" } },
    },
    done: {
      on: { land: { target: "landed" } },
    },
    landed: { type: "final" },
    pending: {
      on: { start: { target: "running" } },
    },
    running: {
      on: {
        finish: ({ context }) => ({
          target: context.gated ? "blocked_on_human" : "done",
        }),
      },
    },
  },
});

export const statusOf = (snapshot: SnapshotFrom<typeof taskMachine>): TaskStatus => snapshot.value;
