import { Config as CairnConfig } from "@cairn/contract";
import {
  Array,
  Effect,
  Layer,
  Match,
  Number,
  Option,
  Predicate,
  Record,
  Schema,
  Struct,
} from "effect";
import { DecisionModel } from "effect/ai";
import type { Decision } from "effect/ai";

import { Judge } from "../src/judge.ts";

/** A rated or classified answer: the label and the confidence the model gives it. */
export interface Pick {
  readonly confidence: number;
  readonly label: string;
}

/** What the scripted decision model answers. A target is named by its title, and the stack by "". */
export interface Script {
  /** The rated or classified answer to a question about the target titled `title`; none keeps the default. */
  readonly answer?: (title: string, question: string) => Option.Option<Pick>;
  /** The probability of a yes-or-no question about the target titled `title`; none keeps 0.9. */
  readonly probability?: (title: string, question: string) => Option.Option<number>;
}

/**
 * Right-sized, and sure that the planner's `feature`, `sonnet` and `high` are what the task needs, so a
 * script says only what a test is about.
 */
const defaultPick = (question: string, labels: ReadonlyArray<string>): Pick =>
  Match.value(question).pipe(
    Match.when("size", (): Pick => ({ confidence: 0.9, label: "right" })),
    Match.when("category", (): Pick => ({ confidence: 0.9, label: "feature" })),
    Match.when("model", (): Pick => ({ confidence: 0.9, label: "sonnet" })),
    Match.when("reasoning", (): Pick => ({ confidence: 0.9, label: "high" })),
    Match.orElse((): Pick => ({
      confidence: 0.1,
      label: Option.getOrElse(Array.head(labels), () => ""),
    })),
  );

/** The chosen label has `probability`; the others share the rest, so the distribution sums to 1. */
const oneHot = (labels: ReadonlyArray<string>, chosen: string, probability: number) => {
  const others = Number.max(Number.decrement(Array.length(labels)), 1);
  return Record.fromEntries(
    Array.map(
      labels,
      (label) =>
        [
          label,
          label === chosen
            ? Array.length(labels) > 1
              ? probability
              : 1
            : Number.divideUnsafe(Number.subtract(1, probability), others),
        ] as const,
    ),
  );
};

const answerFor = (
  title: string,
  name: string,
  decision: Exclude<Decision.Any, Decision.Locate>,
  script: Script,
): DecisionModel.ProviderAnswer => {
  const pick = (labels: ReadonlyArray<string>) =>
    Option.getOrElse(
      Option.flatMap(Option.fromUndefinedOr(script.answer), (answer) => answer(title, name)),
      () => defaultPick(name, labels),
    );
  return Match.value(decision).pipe(
    Match.tag("Probability", (): DecisionModel.ProviderAnswer => ({
      _tag: "Probability",
      probability: Option.getOrElse(
        Option.flatMap(Option.fromUndefinedOr(script.probability), (say) => say(title, name)),
        () => 0.9,
      ),
    })),
    Match.tag("Rate", ({ criteria }): DecisionModel.ProviderAnswer => {
      const labels = Array.map(criteria, Struct.get("label"));
      const { confidence, label } = pick(labels);
      return {
        _tag: "Rate",
        confidence,
        probabilities: oneHot(labels, label, confidence),
        rating: Option.getOrElse(
          Array.findFirstIndex(labels, (each) => each === label),
          () => 0,
        ),
      };
    }),
    Match.tag("Classify", ({ criteria }): DecisionModel.ProviderAnswer => {
      const labels = Record.keys(criteria);
      const { confidence, label } = pick(labels);
      return {
        _tag: "Classify",
        confidence,
        label,
        probabilities: oneHot(labels, label, confidence),
      };
    }),
    Match.exhaustive,
  );
};

const titleOf = (state: unknown) =>
  Predicate.hasProperty(state, "title") && Predicate.isString(state.title) ? state.title : "";

/** The config every field of which is its default. */
export const defaults = Schema.decodeSync(CairnConfig)({});

/** The real `Judge` over a decision model that answers from `script`, so verdicts are the real ones. */
export const scriptedJudge = (script: Script = {}) =>
  Judge.layerWith(defaults).pipe(
    Layer.provide(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: (options) =>
            Effect.succeed({
              answers: Record.map(options.decisions, (decision, name) =>
                answerFor(titleOf(options.state), name, decision, script),
              ),
              usage: { inputTokens: 1, outputTokens: 1 },
            }),
        }),
      ),
    ),
  );
