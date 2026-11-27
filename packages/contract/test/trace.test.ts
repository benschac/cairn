import { expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";

import { SectionId } from "../src/ids.ts";
import { Judgment } from "../src/judgments.ts";
import { SectionStatus } from "../src/manifest.ts";
import {
  Trace,
  TraceJson,
  TraceSection,
  TraceJudgment,
  TraceTask,
  TraceWarning,
} from "../src/trace.ts";

const encode = Schema.encodeSync(TraceJson);
const decode = Schema.decodeUnknownSync(TraceJson);
const encodeTrace = Schema.encodeSync(Trace);
const refused = (schema: Schema.Decoder<unknown>, input: unknown) =>
  Exit.isFailure(Schema.decodeUnknownExit(schema)(input));

it.prop(
  "a trace survives a round trip through JSON",
  [Trace],
  ([trace]) => {
    // Compare the JSON text: JSON has no -0, so a generated -0 would fail toEqual for no real reason.
    const json = encode(trace);
    expect(encode(decode(json))).toBe(json);
  },
  // A generated trace can be large. The runs take about 300 ms on a laptop but went past the
  // default 5 s on CI runners busy with the other checks, which failed unrelated pull requests.
  { timeout: 30_000 },
);

it("a minimal trace decodes", () => {
  const minimal = {
    baseBranch: "main",
    feature: "demo",
    judgments: [],
    prd: { markdown: "", path: ".cairn/prd.md", sections: [] },
    sections: [],
    spec: { markdown: "", path: ".cairn/spec.md", sections: [] },
    tasks: [],
    version: 1,
    warnings: [],
  };
  expect(refused(Trace, minimal)).toBe(false);
  expect(Schema.decodeUnknownSync(Trace)(minimal).notes).toEqual([]);
});

it.prop(
  "a section keeps its summary, and one written without it decodes with null",
  [TraceSection],
  ([section]) => {
    const encoded = Schema.encodeSync(TraceSection)(section);
    expect(Schema.decodeSync(TraceSection)(encoded).summary).toBe(section.summary);
    const { summary: _summary, ...without } = encoded;
    expect(Schema.decodeUnknownSync(TraceSection)(without).summary).toBeNull();
    expect(refused(TraceSection, { ...encoded, summary: 1 })).toBe(true);
  },
);

it.prop(
  "every section status decodes and an unknown one is refused",
  [Trace, SectionId, SectionStatus],
  ([trace, id, status]) => {
    const encoded = encodeTrace(trace);
    expect(refused(Trace, { ...encoded, sections: [{ id, status }] })).toBe(false);
    expect(refused(Trace, { ...encoded, sections: [{ id, status: "merged" }] })).toBe(true);
  },
);

it.prop("refuses a trace with a version other than 1", [Trace], ([trace]) => {
  expect(refused(Trace, { ...encodeTrace(trace), version: 2 })).toBe(true);
});

it.prop("refuses a bad warning kind", [TraceWarning], ([warning]) => {
  const encoded = Schema.encodeSync(TraceWarning)(warning);
  expect(refused(TraceWarning, encoded)).toBe(false);
  expect(refused(TraceWarning, { ...encoded, kind: "oops" })).toBe(true);
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

it.prop(
  "a judgment in a trace is refused when its verdict or input hash is malformed",
  [Trace, TraceJudgment],
  ([trace, judgment]) => {
    const encoded = Schema.encodeSync(TraceJudgment)(judgment);
    const withJudgment = (j: object) => ({ ...encodeTrace(trace), judgments: [j] });
    expect(refused(Trace, withJudgment(encoded))).toBe(false);
    expect(refused(Trace, withJudgment({ ...encoded, verdict: "maybe" }))).toBe(true);
    expect(refused(Trace, withJudgment({ ...encoded, inputHash: "xyz" }))).toBe(true);
    expect(refused(Trace, withJudgment({ ...encoded, stale: "no" }))).toBe(true);
  },
);
