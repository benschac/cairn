import { expect, it } from "@effect/vitest";
import { Exit, Schema, String } from "effect";

import { Judgment, Judgments, JudgmentsJson, Sha256Hex } from "../src/index.ts";

const encode = Schema.encodeSync(JudgmentsJson);
const decode = Schema.decodeUnknownSync(JudgmentsJson);
const refused = (schema: Schema.Decoder<unknown>, input: unknown) =>
  Exit.isFailure(Schema.decodeUnknownExit(schema)(input));

const stack = {
  action: "none",
  answer: { probability: 0.9 },
  at: "2026-01-01T00:00:00.000Z",
  inputHash: String.repeat(64)("a"),
  message: "ok",
  question: "ordered",
  round: 1,
  target: { kind: "stack" },
  verdict: "pass",
};

it.prop("judgments survive a round trip through JSON", [Judgments], ([judgments]) => {
  // Compare the JSON text: JSON has no -0, so a generated -0 would fail toEqual for no real reason.
  const json = encode(judgments);
  expect(encode(decode(json))).toBe(json);
});

it("a minimal judgments file decodes, and an empty one needs its model", () => {
  expect(refused(Judgments, { judgments: [stack], model: "jev-1.14.0", version: 1 })).toBe(false);
  expect(refused(Judgments, { judgments: [], model: "jev-1.14.0", version: 1 })).toBe(false);
  expect(refused(Judgments, { judgments: [] })).toBe(true);
  expect(refused(Judgments, { judgments: [], model: "m", version: 2 })).toBe(true);
});

it("each answer shape decodes, and a mixed one does not", () => {
  const rate = { confidence: 0.7, label: "yes", probabilities: { no: 0.1, yes: 0.9 } };
  const unanswered = { description: "no reply", unanswered: "Missing" };
  expect(refused(Judgment, { ...stack, answer: rate })).toBe(false);
  expect(refused(Judgment, { ...stack, answer: { label: "yes", probabilities: {} } })).toBe(false);
  expect(refused(Judgment, { ...stack, answer: unanswered })).toBe(false);
  expect(refused(Judgment, { ...stack, answer: { unanswered: "Gone", description: "" } })).toBe(
    true,
  );
  expect(refused(Judgment, { ...stack, answer: { probability: "high" } })).toBe(true);
});

it("a draft target carries a title, and a section target a section id", () => {
  expect(refused(Judgment, { ...stack, target: { kind: "draft", title: "Split me" } })).toBe(false);
  expect(refused(Judgment, { ...stack, target: { kind: "draft" } })).toBe(true);
  expect(refused(Judgment, { ...stack, target: { kind: "section", id: "not a section" } })).toBe(
    true,
  );
  expect(refused(Judgment, { ...stack, target: { kind: "other" } })).toBe(true);
});

it("a judgment refuses an unknown question, verdict or action, and a round below 1", () => {
  expect(refused(Judgment, { ...stack, question: "vibes" })).toBe(true);
  expect(refused(Judgment, { ...stack, verdict: "maybe" })).toBe(true);
  expect(refused(Judgment, { ...stack, action: "merge" })).toBe(true);
  expect(refused(Judgment, { ...stack, round: 0 })).toBe(true);
  expect(refused(Judgment, { ...stack, round: 1.5 })).toBe(true);
});

it("an input hash is 64 lowercase hex characters", () => {
  expect(refused(Sha256Hex, String.repeat(64)("a"))).toBe(false);
  expect(refused(Sha256Hex, String.repeat(64)("A"))).toBe(true);
  expect(refused(Sha256Hex, String.repeat(63)("a"))).toBe(true);
  expect(refused(Sha256Hex, String.repeat(64)("g"))).toBe(true);
});
