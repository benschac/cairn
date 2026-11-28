import { Config, ProbabilityAnswer, RateAnswer, Reasoning, Unanswered } from "@cairn/contract";
import type { Verdict } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Number, Option, Order, Record, Schema, String, pipe } from "effect";

import { routeOf, verdictOf } from "../src/index.ts";

/** Thresholds as config decodes them: `pass` above `flag`, every number in [0, 1]. */
const Judge = Config.fields.judge;
const Unit = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));
const ProbabilityQuestion = Schema.Literals([
  "buildable",
  "complete",
  "faithful",
  "matches",
  "oneFeature",
  "ordered",
]);
const RatedQuestion = Schema.Literals(["size", "model", "reasoning"]);
const AnyQuestion = Schema.Union([ProbabilityQuestion, RatedQuestion]);
const Routed = Schema.Struct({ model: Schema.NonEmptyString, reasoning: Reasoning });

/** From worst to best: a lower rank is a verdict nearer to `flag`. */
const RANK = { flag: 0, pass: 2, unsure: 1 } as const satisfies { readonly [V in Verdict]: number };
const byRank = Order.mapInput(Order.Number, (verdict: Verdict) => RANK[verdict]);

const sorted = (a: number, b: number): readonly [number, number] =>
  Order.isLessThanOrEqualTo(Order.Number)(a, b) ? [a, b] : [b, a];

const rate = (label: string, confidence: number | undefined): RateAnswer => ({
  ...(confidence === undefined ? {} : { confidence }),
  label,
  probabilities: {},
});

it.prop(
  "raising a probability never lowers the verdict",
  [Judge, Schema.Finite, Schema.Finite, ProbabilityQuestion],
  ([judge, a, b, question]) => {
    const [low, high] = sorted(a, b);
    const at = (probability: number) => verdictOf(question, { probability }, judge).verdict;
    expect(Order.isLessThanOrEqualTo(byRank)(at(low), at(high))).toBe(true);
  },
);

it.prop(
  "a probability is judged against pass and flag",
  [Judge, ProbabilityQuestion],
  ([judge, question]) => {
    const at = (probability: number) => verdictOf(question, { probability }, judge).verdict;
    expect(at(judge.pass)).toBe("pass");
    expect(at(judge.flag)).toBe("unsure");
    expect(at(Number.sum(judge.pass, 1))).toBe("pass");
    expect(at(Number.subtract(judge.flag, 1))).toBe("flag");
  },
);

it.prop(
  "lowering the confidence never turns a rate answer into a pass",
  [Judge, Schema.NonEmptyString, Unit, Unit, RatedQuestion, Schema.Boolean, Routed],
  ([judge, label, a, b, question, withTask, task]) => {
    const [low, high] = sorted(a, b);
    const at = (confidence: number) =>
      verdictOf(question, rate(label, confidence), judge, withTask ? task : undefined).verdict;
    expect(at(low) === "pass" ? at(high) : "pass").toBe("pass");
  },
);

it.prop(
  "a rate answer below minConfidence, or with none, is unsure",
  [Judge, Schema.NonEmptyString, Unit, RatedQuestion, Routed],
  ([judge, label, confidence, question, task]) => {
    const below = Number.multiply(confidence, judge.minConfidence);
    const unsure = (answer: RateAnswer) =>
      verdictOf(question, answer, judge, task).verdict === "unsure";
    expect(Number.isLessThan(below, judge.minConfidence) ? unsure(rate(label, below)) : true).toBe(
      true,
    );
    expect(unsure(rate(label, undefined))).toBe(true);
  },
);

it.prop(
  "an unanswered decision is never a pass, and says why",
  [Judge, Unanswered, AnyQuestion, Schema.Boolean, Routed],
  ([judge, unanswered, question, withTask, task]) => {
    const { message, verdict } = verdictOf(
      question,
      unanswered,
      judge,
      withTask ? task : undefined,
    );
    expect(verdict).toBe("unsure");
    expect(message).toContain(unanswered.unanswered);
    expect(message).toContain(unanswered.description);
  },
);

it.prop(
  "an answer of the wrong kind for its question is unsure",
  [Judge, ProbabilityAnswer, RateAnswer, ProbabilityQuestion, RatedQuestion],
  ([judge, probability, rated, probabilityQuestion, ratedQuestion]) => {
    expect(verdictOf(ratedQuestion, probability, judge).verdict).toBe("unsure");
    expect(verdictOf(probabilityQuestion, rated, judge).verdict).toBe("unsure");
  },
);

it.prop(
  "size passes only a confident right and names the label of a flag",
  [Judge, Schema.Literals(["too_small", "right", "too_large"]), Unit],
  ([judge, label, spread]) => {
    const confidence = Number.sum(
      judge.minConfidence,
      Number.multiply(spread, Number.subtract(1, judge.minConfidence)),
    );
    const { message, verdict } = verdictOf("size", rate(label, confidence), judge);
    expect(verdict).toBe(label === "right" ? "pass" : "flag");
    expect(String.includes(label)(message)).toBe(true);
  },
);

it.prop(
  "a confident model or reasoning answer passes, and flags when it differs from the task",
  [Judge, Schema.NonEmptyString, Routed, Unit, Schema.Literals(["model", "reasoning"])],
  ([judge, label, task, spread, question]) => {
    const confidence = Number.sum(
      judge.minConfidence,
      Number.multiply(spread, Number.subtract(1, judge.minConfidence)),
    );
    const answer = rate(label, confidence);
    expect(verdictOf(question, answer, judge).verdict).toBe("pass");
    expect(verdictOf(question, answer, judge, task).verdict).toBe(
      task[question] === label ? "pass" : "flag",
    );
    expect(verdictOf(question, rate(task[question], confidence), judge, task).verdict).toBe("pass");
  },
);

const Answer = Schema.Union([RateAnswer, ProbabilityAnswer, Unanswered]);
const Names = Schema.NonEmptyArray(Schema.NonEmptyString);

/** The names as `judge.models`, with a description each. */
const modelsOf = (names: Array.NonEmptyReadonlyArray<string>) =>
  Record.fromIterableWith(names, (name) => [name, `use ${name}`] as const);

/** A rate answer that is confident under `judge`. */
const confident = (
  judge: { readonly minConfidence: number },
  label: string,
  confidence: number,
): RateAnswer => rate(label, Order.max(Order.Number)(confidence, judge.minConfidence));

it.prop(
  "routeOf never returns a model that is not in judge.models",
  [
    Judge,
    Names,
    Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 })),
    Schema.Boolean,
    Schema.Boolean,
    Unit,
    Answer,
    Reasoning,
    Answer,
  ],
  ([judge, names, pick, answerListed, plannerListed, confidence, any, reasoning, anyReasoning]) => {
    const models = modelsOf(names);
    const listed = pipe(
      Array.get(names, Number.remainder(pick, Array.length(names))),
      Option.getOrElse(() => Array.headNonEmpty(names)),
    );
    // Labels no name can equal: longer than every name.
    const joined = Array.join(names, "|");
    const planner = plannerListed ? listed : String.concat(joined, "?");
    const thresholds = { ...judge, models };
    const returnsListed = (answers: Parameters<typeof routeOf>[0]) =>
      Option.match(routeOf(answers, { model: planner, reasoning }, thresholds).model.value, {
        onNone: () => true,
        onSome: (model) => Record.has(models, model),
      });

    // A confident answer, in the config or not.
    const confidentRoute = routeOf(
      {
        model: confident(judge, answerListed ? listed : String.concat(joined, "!"), confidence),
        reasoning: confident(judge, "none of them", confidence),
      },
      { model: planner, reasoning },
      thresholds,
    );
    expect(returnsListed({ model: confident(judge, listed, confidence), reasoning: any })).toBe(
      true,
    );
    expect(confidentRoute.model.source).toBe(answerListed ? "judge" : "planner");
    expect(confidentRoute.model.value).toStrictEqual(
      answerListed || plannerListed ? Option.some(answerListed ? listed : planner) : Option.none(),
    );
    // Whatever the answers are, including none.
    expect(returnsListed({ model: any, reasoning: anyReasoning })).toBe(true);
    expect(confidentRoute.reasoning.value).toStrictEqual(Option.some(reasoning));
  },
);

it.prop(
  "routeOf takes a confident answer and keeps the planner's value otherwise",
  [Judge, Names, Names, Unit, Reasoning, Reasoning],
  ([judge, planned, chosen, confidence, plannedReasoning, chosenReasoning]) => {
    // Jev's model is one the config names; the planner's is one it names too.
    const models = modelsOf(Array.appendAll(planned, chosen));
    const planner = Array.headNonEmpty(planned);
    const jev = Array.headNonEmpty(chosen);
    const thresholds = { ...judge, models };
    const sure = routeOf(
      { model: confident(judge, jev, confidence), reasoning: confident(judge, chosenReasoning, 1) },
      { model: planner, reasoning: plannedReasoning },
      thresholds,
    );
    expect(sure.model).toMatchObject({ source: "judge", value: Option.some(jev), verdict: "pass" });
    expect(sure.reasoning).toMatchObject({
      source: "judge",
      value: Option.some(chosenReasoning),
      verdict: "pass",
    });

    // No confidence is always doubtful; so is half of `minConfidence` when that is above zero.
    const doubtful = Number.isGreaterThan(judge.minConfidence, 0)
      ? rate(jev, Number.multiply(judge.minConfidence, 0.5))
      : rate(jev, undefined);
    const doubtfulReasoning = { ...doubtful, label: chosenReasoning };
    const unsure = routeOf(
      { model: doubtful, reasoning: doubtfulReasoning },
      { model: planner, reasoning: plannedReasoning },
      thresholds,
    );
    expect(unsure.model).toMatchObject({
      source: "planner",
      value: Option.some(planner),
      verdict: "unsure",
    });
    expect(unsure.reasoning).toMatchObject({
      source: "planner",
      value: Option.some(plannedReasoning),
      verdict: "unsure",
    });
  },
);

it("separable reports splitting at a yes, reordering at a no and the hotspot alone between", () => {
  const thresholds = Schema.decodeSync(Judge)({});
  const verdict = (probability: number) => verdictOf("separable", { probability }, thresholds);
  expect(verdict(1)).toMatchObject({ verdict: "flag" });
  expect(String.startsWith("split the file")(verdict(1).message)).toBe(true);
  expect(verdict(0)).toMatchObject({ verdict: "flag" });
  expect(String.startsWith("reorder the work")(verdict(0).message)).toBe(true);
  const between = (thresholds.flag + thresholds.pass) / 2;
  expect(verdict(between)).toMatchObject({ verdict: "unsure" });
  expect(String.startsWith("a hotspot")(verdict(between).message)).toBe(true);
});
