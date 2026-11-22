import { expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";

import { Judgment } from "../src/judgments.ts";
import { SectionStatus } from "../src/manifest.ts";
import { Trace, TraceJson, TraceTask, TraceWarning } from "../src/trace.ts";

const encode = Schema.encodeSync(TraceJson);
const decode = Schema.decodeUnknownSync(TraceJson);
const refused = (schema: Schema.Decoder<unknown>, input: unknown) =>
  Exit.isFailure(Schema.decodeUnknownExit(schema)(input));

it.prop("a trace survives a round trip through JSON", [Trace], ([trace]) => {
  // Compare the JSON text: JSON has no -0, so a generated -0 would fail toEqual for no real reason.
  const json = encode(trace);
  expect(encode(decode(json))).toBe(json);
});

const baseTrace = (): Record<string, unknown> => ({
  baseBranch: "main",
  feature: "demo",
  judgments: [],
  prd: { markdown: "", path: ".cairn/prd.md", sections: [] },
  sections: [],
  spec: { markdown: "", path: ".cairn/spec.md", sections: [] },
  tasks: [],
  version: 1,
  warnings: [],
});

it("a minimal trace decodes", () => {
  expect(Exit.isSuccess(Schema.decodeUnknownExit(Trace)(baseTrace()))).toBe(true);
});

it.prop("every section status decodes", [SectionStatus], ([status]) => {
  const input = { ...baseTrace(), sections: [{ id: "spec.a", status }] };
  expect(Exit.isSuccess(Schema.decodeUnknownExit(Trace)(input))).toBe(true);
});

it("refuses a section status that does not exist", () => {
  const input = { ...baseTrace(), sections: [{ id: "spec.a", status: "merged" }] };
  expect(refused(Trace, input)).toBe(true);
});

it("refuses a trace with a version other than 1", () => {
  expect(refused(Trace, { ...baseTrace(), version: 2 })).toBe(true);
});

it("refuses a bad warning kind", () => {
  const warning = { kind: "oops", message: "m", sha: null, taskId: null };
  expect(refused(TraceWarning, warning)).toBe(true);
  expect(refused(TraceWarning, { ...warning, kind: "unknown-task" })).toBe(false);
});

it.prop("a task keeps the manifest's fields and refuses them malformed", [TraceTask], ([task]) => {
  const encoded = Schema.encodeSync(TraceTask)(task);
  expect(refused(TraceTask, encoded)).toBe(false);
  expect(refused(TraceTask, { ...encoded, commits: ["abc123"] })).toBe(true);
  expect(refused(TraceTask, { ...encoded, status: "merged" })).toBe(true);
  expect(refused(TraceTask, { ...encoded, branch: "no-number" })).toBe(true);
  expect(refused(TraceTask, { ...encoded, waiting: "yes" })).toBe(true);
  expect(refused(TraceTask, { ...encoded, humanGate: undefined })).toBe(true);
});

it.prop(
  "a judgment survives a round trip, and an unknown verdict is refused",
  [Judgment],
  ([judgment]) => {
    const encoded = Schema.encodeSync(Judgment)(judgment);
    expect(Schema.decodeSync(Judgment)(encoded)).toEqual(judgment);
    expect(refused(Judgment, { ...encoded, verdict: "maybe" })).toBe(true);
  },
);

it("a judgment in a trace is refused when its verdict is unknown", () => {
  const judgment = {
    action: "none",
    answer: { probability: 0.5 },
    at: "2026-01-02T03:04:05.000Z",
    inputHash: "a".repeat(64),
    message: "m",
    question: "size",
    round: 1,
    stale: false,
    target: { kind: "stack" },
    verdict: "pass",
  };
  const ok = { ...baseTrace(), judgments: [judgment] };
  expect(refused(Trace, ok)).toBe(false);
  expect(refused(Trace, { ...ok, judgments: [{ ...judgment, verdict: "maybe" }] })).toBe(true);
  expect(refused(Trace, { ...ok, judgments: [{ ...judgment, inputHash: "xyz" }] })).toBe(true);
});
