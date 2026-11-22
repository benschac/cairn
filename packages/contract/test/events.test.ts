import { expect, it } from "@effect/vitest";
import { DateTime, Exit, Schema, Struct } from "effect";

import { Actor, Event, EventJson } from "../src/events.ts";
import { TaskStatus } from "../src/index.ts";

const encode = Schema.encodeSync(EventJson);
const encodeFields = Schema.encodeSync(Event);
const decode = Schema.decodeUnknownSync(EventJson);
const decodeExit = Schema.decodeUnknownExit(EventJson);
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const line = (fields: Record<string, unknown>) =>
  toJson({ status: "running", taskId: "t1", ts: "2026-01-02T03:04:05.000Z", ...fields });

it.prop("an event survives a round trip through a JSON line", [Event], ([event]) => {
  expect(decode(encode(event))).toEqual(event);
});

it.prop("a line without v or actor decodes with v 1 and the orchestrator", [Event], ([event]) => {
  const bare = Struct.omit(encodeFields(event), ["actor", "v"]);
  expect(decode(toJson(bare))).toEqual({ ...event, actor: "orchestrator", v: 1 });
});

it("ts decodes to the instant it names", () => {
  expect(DateTime.formatIso(decode(line({})).ts)).toBe("2026-01-02T03:04:05.000Z");
});

it.prop("every status decodes", [TaskStatus], ([status]) => {
  expect(decode(line({ status })).status).toBe(status);
});

it.prop("every actor is kept", [Actor], ([actor]) => {
  expect(decode(line({ actor })).actor).toBe(actor);
});

it.prop("an actor that is not one of the three forms is refused", [Schema.String], ([actor]) => {
  if (Schema.is(Actor)(actor)) return;
  expect(Exit.isFailure(decodeExit(line({ actor })))).toBe(true);
});

it.each([
  line({ actor: "robot:x" }),
  line({ actor: "human" }),
  line({ v: 2 }),
  line({ ts: "yesterday" }),
  line({ taskId: "" }),
  line({ status: "nope" }),
  line({ detail: 5 }),
  "not json",
])("refuses %s", (bad) => {
  expect(Exit.isFailure(decodeExit(bad))).toBe(true);
});
