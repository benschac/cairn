import type { TestFixture } from "@xstate/test";
import { Option } from "effect";

const joined = (kind: "agent" | "human", name: string) =>
  ({
    caseId: '["event-case","joined","default"]',
    event: {
      participant: { id: "bo", kind, name, reading: Option.none() },
      type: "joined",
    },
    origin: "generator",
    phase: "generated",
    type: "event",
  }) as const;

/**
 * The shrunk failure `propertyTest` printed when the presence server did not leave on a socket
 * close: one participant joined twice, and the first client stayed in the room. It is the
 * `failure.fixture` of that run.
 */
export const leftOnClose = {
  failedAt: 3,
  formatVersion: 2,
  machine: { id: "room" },
  start: { input: undefined, type: "input" },
  timeline: [
    { command: joined("human", "A"), kind: "event" },
    { command: joined("agent", "0"), kind: "event" },
  ],
} as const satisfies TestFixture;
