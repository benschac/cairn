import { Schema } from "effect";

import { SpecSectionId, TaskId } from "./ids.ts";

/** A SHA-256 digest: 64 lowercase hex characters. */
export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("Sha256Hex"),
);
export type Sha256Hex = typeof Sha256Hex.Type;

export const RateAnswer = Schema.Struct({
  confidence: Schema.optionalKey(Schema.Finite),
  label: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Finite),
});
export type RateAnswer = typeof RateAnswer.Type;

export const ProbabilityAnswer = Schema.Struct({ probability: Schema.Finite });
export type ProbabilityAnswer = typeof ProbabilityAnswer.Type;

export const Unanswered = Schema.Struct({
  description: Schema.String,
  unanswered: Schema.Literals(["Refused", "Missing", "Invalid"]),
});
export type Unanswered = typeof Unanswered.Type;

export const JudgmentTarget = Schema.Union([
  Schema.Struct({ id: SpecSectionId, kind: Schema.Literal("section") }),
  Schema.Struct({ id: TaskId, kind: Schema.Literal("task") }),
  Schema.Struct({ kind: Schema.Literal("draft"), title: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("stack") }),
]).pipe(Schema.toTaggedUnion("kind"));
export type JudgmentTarget = typeof JudgmentTarget.Type;

export const JudgmentQuestion = Schema.Literals([
  "size",
  "faithful",
  "inScope",
  "buildable",
  "matches",
  "category",
  "model",
  "reasoning",
  "complete",
  "ordered",
  "oneFeature",
]);
export type JudgmentQuestion = typeof JudgmentQuestion.Type;

export const Verdict = Schema.Literals(["pass", "flag", "unsure"]);
export type Verdict = typeof Verdict.Type;

export const Judgment = Schema.Struct({
  action: Schema.Literals(["none", "split", "routed"]),
  answer: Schema.Union([RateAnswer, ProbabilityAnswer, Unanswered]),
  at: Schema.DateTimeUtcFromString,
  inputHash: Sha256Hex,
  message: Schema.String,
  question: JudgmentQuestion,
  round: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  target: JudgmentTarget,
  verdict: Verdict,
});
export type Judgment = typeof Judgment.Type;

/**
 * `.cairn/judgments.json` (`spec.contract.judgments`): the decision model that answered, and
 * every judgment it gave, one per target and question and round.
 */
export const Judgments = Schema.Struct({
  judgments: Schema.Array(Judgment),
  model: Schema.String,
  version: Schema.Literal(1),
});
export type Judgments = typeof Judgments.Type;

export const JudgmentsJson = Schema.fromJsonString(Judgments);
