import { ProbabilityAnswer, RateAnswer, Reasoning, Unanswered } from "@cairn/contract";
import type { Config, Judgment, JudgmentQuestion, ManifestTask, Verdict } from "@cairn/contract";
import { Match, Number, Option, Record, Schema, pipe } from "effect";

/** What the decision model answered to one question, as `judgments.json` stores it. */
export type Answer = Judgment["answer"];

/** The thresholds `verdictOf` reads: `judge.pass`, `judge.flag` and `judge.minConfidence`. */
export type Thresholds = Pick<Config["judge"], "flag" | "minConfidence" | "pass">;

/** `routeOf` also reads `judge.models`, the only models it may return. */
export type RouteThresholds = Thresholds & Pick<Config["judge"], "models">;

/** A verdict and the sentence that says why (`spec.judging.verdicts`). */
export interface Verdicted {
  readonly message: string;
  readonly verdict: Verdict;
}

/** The part of a manifest task `verdictOf` compares a `model` or `reasoning` answer with. */
export type RoutedTask = Pick<ManifestTask, "model" | "reasoning">;

const isUnanswered = Schema.is(Unanswered);
const isRate = Schema.is(RateAnswer);
const isProbability = Schema.is(ProbabilityAnswer);
const isReasoning = Schema.is(Reasoning);

const unsure = (message: string): Verdicted => ({ message, verdict: "unsure" });

/** How each question is answered: a probability, a rating that is judged, or a choice. */
const KIND = {
  buildable: "probability",
  complete: "probability",
  faithful: "probability",
  matches: "probability",
  model: "choice",
  oneFeature: "probability",
  ordered: "probability",
  reasoning: "choice",
  size: "size",
} as const satisfies { readonly [Q in JudgmentQuestion]: "choice" | "probability" | "size" };

const probabilityVerdict = (answer: ProbabilityAnswer, { flag, pass }: Thresholds): Verdicted =>
  Number.isGreaterThanOrEqualTo(answer.probability, pass)
    ? { message: `probability ${answer.probability} is at or above pass ${pass}`, verdict: "pass" }
    : Number.isLessThan(answer.probability, flag)
      ? { message: `probability ${answer.probability} is below flag ${flag}`, verdict: "flag" }
      : unsure(`probability ${answer.probability} is between flag ${flag} and pass ${pass}`);

/** The answer's confidence when it is at or above `minConfidence`; none when low or missing. */
const confidenceOf = (answer: RateAnswer, { minConfidence }: Thresholds): Option.Option<number> =>
  pipe(
    Option.fromUndefinedOr(answer.confidence),
    Option.filter(Number.isGreaterThanOrEqualTo(minConfidence)),
  );

const lowConfidence = (answer: RateAnswer, { minConfidence }: Thresholds): Verdicted =>
  unsure(
    pipe(
      Option.fromUndefinedOr(answer.confidence),
      Option.match({
        onNone: () => `${answer.label} came with no confidence`,
        onSome: (confidence) =>
          `${answer.label} has confidence ${confidence}, below minConfidence ${minConfidence}`,
      }),
    ),
  );

const sizeVerdict = (answer: RateAnswer, thresholds: Thresholds): Verdicted =>
  Option.match(confidenceOf(answer, thresholds), {
    onNone: () => lowConfidence(answer, thresholds),
    onSome: (confidence) =>
      answer.label === "right"
        ? { message: `size is right, confidence ${confidence}`, verdict: "pass" }
        : { message: `size is ${answer.label}, confidence ${confidence}`, verdict: "flag" },
  });

/** A `model` or `reasoning` answer: `pass` when confident, `flag` when it differs from the task's. */
const choiceVerdict = (
  question: "model" | "reasoning",
  answer: RateAnswer,
  thresholds: Thresholds,
  task: Option.Option<RoutedTask>,
): Verdicted =>
  Option.match(confidenceOf(answer, thresholds), {
    onNone: () => lowConfidence(answer, thresholds),
    onSome: (confidence) =>
      pipe(
        task,
        Option.map((routed) => routed[question]),
        Option.filter((current) => current !== answer.label),
        Option.match({
          onNone: () => ({
            message: `${question} ${answer.label}, confidence ${confidence}`,
            verdict: "pass" as const,
          }),
          onSome: (current) => ({
            message: `${question} ${answer.label} differs from the manifest's ${current}, confidence ${confidence}`,
            verdict: "flag" as const,
          }),
        }),
      ),
  });

const wrongShape = (question: JudgmentQuestion): Verdicted =>
  unsure(`the answer is not the kind ${question} asks for`);

/**
 * What an answer means (`spec.judging.verdicts`). Pure.
 *
 * - A probability: `pass` at or above `pass`, `flag` below `flag`, `unsure` between.
 * - `size`: `unsure` below `minConfidence`; otherwise `pass` for `right` and `flag` for the
 *   other labels, named in the message.
 * - `model` and `reasoning` choose rather than judge: `unsure` below `minConfidence`, `pass`
 *   above it. With `task`, a confident label that differs from the task's value is a `flag`.
 * - An unanswered decision, or an answer of the wrong kind for the question, is `unsure`.
 */
export const verdictOf = (
  question: JudgmentQuestion,
  outcome: Answer,
  thresholds: Thresholds,
  task?: RoutedTask,
): Verdicted =>
  Match.value(outcome).pipe(
    Match.when(isUnanswered, ({ description, unanswered }) =>
      unsure(`${unanswered}: ${description}`),
    ),
    Match.when(isRate, (answer) =>
      Match.value(KIND[question]).pipe(
        Match.when("size", () => sizeVerdict(answer, thresholds)),
        Match.when("choice", () =>
          choiceVerdict(
            question === "model" ? "model" : "reasoning",
            answer,
            thresholds,
            Option.fromUndefinedOr(task),
          ),
        ),
        Match.when("probability", () => wrongShape(question)),
        Match.exhaustive,
      ),
    ),
    Match.when(isProbability, (answer) =>
      KIND[question] === "probability"
        ? probabilityVerdict(answer, thresholds)
        : wrongShape(question),
    ),
    Match.exhaustive,
  );

/**
 * The value `routeOf` picked, where it came from, and whether Jev was sure. `value` is none only
 * for a model: the planner's model is not in `judge.models` and Jev gave no usable one, so there
 * is no configured model to return and the caller keeps the draft as it is.
 */
export interface Route<A> {
  readonly message: string;
  readonly source: "judge" | "planner";
  readonly value: Option.Option<A>;
  readonly verdict: "pass" | "unsure";
}

const routeFor = <A extends string>(
  question: "model" | "reasoning",
  answer: Answer,
  planner: string,
  thresholds: Thresholds,
  parse: (label: string) => Option.Option<A>,
  kept: Option.Option<A>,
): Route<A> => {
  const { message, verdict } = verdictOf(question, answer, thresholds);
  const keep = (why: string): Route<A> => ({
    message: Option.isSome(kept)
      ? `${why}; kept the planner's ${planner}`
      : `${why}; the planner's ${planner} is not in judge.models, so no ${question} is chosen`,
    source: "planner",
    value: kept,
    verdict: "unsure",
  });
  // A confident answer passes only as a rating, so `pass` and a label go together.
  return Option.match(
    verdict === "pass" && isRate(answer) ? Option.some(answer.label) : Option.none(),
    {
      onNone: () => keep(message),
      onSome: (label) =>
        Option.match(parse(label), {
          onNone: () => keep(`${label} is not a ${question} the plan can use`),
          onSome: (value) => ({
            message,
            source: "judge",
            value: Option.some(value),
            verdict: "pass",
          }),
        }),
    },
  );
};

const reasoningLabel = (label: string) => Option.liftPredicate(label, isReasoning);

/**
 * The model and reasoning to use (`spec.judging.verdicts`). Pure. A confident answer gives Jev's
 * label and `pass`; a low-confidence, unanswered or unusable one keeps the planner's value and
 * gives `unsure`. A label outside `judge.models`, or that is no reasoning level, is unusable.
 * The planner's model is kept only when `judge.models` names it: otherwise `model.value` is none,
 * so `routeOf` never returns a model the config does not name. `reasoning.value` is always some.
 */
export const routeOf = (
  answers: { readonly model: Answer; readonly reasoning: Answer },
  draft: { readonly model: string; readonly reasoning: Reasoning },
  thresholds: RouteThresholds,
): { readonly model: Route<string>; readonly reasoning: Route<Reasoning> } => {
  const listed = (label: string) =>
    Option.liftPredicate(label, (name) => Record.has(thresholds.models, name));
  return {
    model: routeFor("model", answers.model, draft.model, thresholds, listed, listed(draft.model)),
    reasoning: routeFor(
      "reasoning",
      answers.reasoning,
      draft.reasoning,
      thresholds,
      reasoningLabel,
      Option.some(draft.reasoning),
    ),
  };
};
