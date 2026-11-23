import { expect, it } from "@effect/vitest";
import { Array, Exit, Schema } from "effect";

import { Session } from "../src/session.ts";

const encode = Schema.encodeSync(Session);
const decode = Schema.decodeUnknownSync(Session);
const decodeExit = Schema.decodeUnknownExit(Session);

const at = "2026-01-02T03:04:05.000Z";
const base = {
  format: "claude-code",
  id: "s_abc123",
  notes: [],
  redactions: {},
  skipped: 0,
  taskId: "t1",
  version: 1,
};
const reply = (id: string) => ({ at, id, kind: "reply", text: "done" });

it.prop("a session survives a round trip", [Session], ([session]) => {
  expect(decode(encode(session))).toEqual(session);
});

it.prop("a session with two turns sharing an id is refused", [Session], ([session]) => {
  const encoded = encode(session);
  const turns = Array.appendAll(encoded.turns, Array.take(encoded.turns, 1));
  if (!Array.isReadonlyArrayNonEmpty(encoded.turns)) return;
  expect(Exit.isFailure(decodeExit({ ...encoded, turns }))).toBe(true);
});

it("the refusal says why", () => {
  const exit = decodeExit({ ...base, turns: [reply("a"), reply("a")] });
  expect(String(exit)).toContain("turn ids must be unique");
});

it("an unknown turn kind is refused", () => {
  const turns = [{ at, id: "a", kind: "thought", text: "hm" }];
  expect(Exit.isFailure(decodeExit({ ...base, turns }))).toBe(true);
});

it("a tool turn with edits decodes", () => {
  const tool = {
    at,
    edits: [{ added: ["x"], path: "a.ts", removed: ["y"] }],
    failed: false,
    id: "call_1",
    input: "{}",
    kind: "tool",
    name: "Edit",
    output: "",
    target: "a.ts",
  };
  const session = decode({ ...base, turns: [tool, reply("b")] });
  expect(session.turns).toHaveLength(2);
});
