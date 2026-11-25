import type { TestFixture } from "@xstate/test";
import { Struct } from "effect";

const generated = <const Type extends string, const Payload extends object>(
  type: Type,
  payload: Payload,
) =>
  ({
    command: {
      caseId: `["event-case","${type}","default"]`,
      event: Struct.assign(payload, { type }),
      origin: "generator",
      phase: "generated",
      type: "event",
    },
    kind: "event",
  }) as const;

const reported = (actor: "agent" | "human", status: string) =>
  generated("reported", { actor, status });

/**
 * The shrunk failure `propertyTest` printed when `derive` let any actor's `done` approve a task in
 * `blocked_on_human`: an agent finished a task, a commit then touched a migration, and the agent's
 * own `done` took the gated task on to `done`.
 */
export const agentApproves = {
  failedAt: 5,
  formatVersion: 2,
  machine: { id: "derivation" },
  start: { input: undefined, type: "input" },
  timeline: [
    reported("agent", "running"),
    reported("agent", "blocked_on_human"),
    reported("agent", "done"),
    generated("committed", { gated: true }),
  ],
} as const satisfies TestFixture;

/**
 * The shrunk failure `propertyTest` printed when `derive` read the gate only from commits the base
 * branch did not reach: a merge took the migration out of the gate, and the task landed without a
 * human and without a warning.
 */
export const landingSkipsGate = {
  failedAt: 5,
  formatVersion: 2,
  machine: { id: "derivation" },
  start: { input: undefined, type: "input" },
  timeline: [
    reported("human", "running"),
    reported("human", "done"),
    generated("committed", { gated: true }),
    generated("merged", {}),
  ],
} as const satisfies TestFixture;
