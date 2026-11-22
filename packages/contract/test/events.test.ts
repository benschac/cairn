import { expect, it } from "@effect/vitest";
import { DateTime, Exit, Schema } from "effect";

import { Event, EventJson } from "../src/events.ts";
import { TaskStatus } from "../src/index.ts";

const encode = Schema.encodeSync(EventJson);
const decode = Schema.decodeUnknownSync(EventJson);
const decodeExit = Schema.decodeUnknownExit(EventJson);

const line = (fields: Record<string, unknown>) =>
  JSON.stringify({ status: "running", taskId: "t1", ts: "2026-01-02T03:04:05.000Z", ...fields });

it.prop("an event survives a round trip through a JSON line", [Event], ([event]) => {
  expect(decode(encode(event))).toEqual(event);
});

it("a line without v or actor decodes with v 1 and the orchestrator", () => {
  const event = decode(line({}));
  expect(event.v).toBe(1);
  expect(event.actor).toBe("orchestrator");
  expect(DateTime.toEpochMillis(event.ts)).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
});

it.prop("every status decodes", [TaskStatus], ([status]) => {
  expect(decode(line({ status })).status).toBe(status);
});

it("human and agent actors are kept", () => {
  expect(decode(line({ actor: "human:ada" })).actor).toBe("human:ada");
  expect(decode(line({ actor: "agent:s_abc123" })).actor).toBe("agent:s_abc123");
});

it("lines that must be refused are refused", () => {
  for (const bad of [
    line({ actor: "robot:x" }),
    line({ actor: "human" }),
    line({ v: 2 }),
    line({ ts: "yesterday" }),
    line({ taskId: "" }),
    line({ status: "nope" }),
    line({ detail: 5 }),
    "not json",
  ]) {
    expect(Exit.isFailure(decodeExit(bad))).toBe(true);
  }
});
