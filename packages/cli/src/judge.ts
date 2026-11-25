import { createHash } from "node:crypto";

import { JudgmentQuestion, JudgmentTarget, RateAnswer, Sha256Hex } from "@cairn/contract";
import type { Config, Judgment, Judgments } from "@cairn/contract";
import { sectionQuestions, stackQuestions, taskQuestions, verdictOf } from "@cairn/core";
import type { Answer, JudgingInputs } from "@cairn/core";
import {
  Array,
  Context,
  DateTime,
  Duration,
  Effect,
  Equal,
  HashSet,
  Layer,
  Option,
  Predicate,
  Record,
  Result,
  Schedule,
  Schema,
  Struct,
} from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";

import { liveDecisionModel } from "./models.ts";

/**
 * Judging failed. With a `target`, the decision model failed on that target's request; without
 * one, the model could not be built, such as when `TYPESAFE_API_KEY` is missing.
 */
export class JudgeError extends Schema.TaggedError<JudgeError, { readonly brand: unique symbol }>()(
  "JudgeError",
  {
    reason: Schema.String,
    target: Schema.optionalKey(JudgmentTarget),
  },
) {
  override get message() {
    return Option.match(Option.fromUndefinedOr(this.target), {
      onNone: () => this.reason,
      onSome: (target) => `Judging ${nameOf(target)} failed: ${this.reason}`,
    });
  }
}

/** How a target is named in a message; also the key that matches a previous judgment to it. */
const nameOf: (target: JudgmentTarget) => string = JudgmentTarget.match({
  draft: ({ title }) => `draft "${title}"`,
  section: ({ id }) => `section ${id}`,
  stack: () => "the stack",
  task: ({ id }) => `task ${id}`,
});

/** The most times a rate-limited request is sent again. */
const RATE_LIMIT_RETRIES = 3;

/** The wait before a retry when the provider's rate-limit error gives no delay. */
const DEFAULT_RETRY_DELAY = Duration.seconds(1);

/** How many requests are in flight at once. */
const CONCURRENT_REQUESTS = 4;

const isRateLimit = (error: AiError.AiError) => Predicate.isTagged(error.reason, "RateLimitError");

/** Waits the delay the provider gives, or `DEFAULT_RETRY_DELAY` when it gives none. */
const providerDelay = Schedule.identity<AiError.AiError>().pipe(
  Schedule.modifyDelay(({ input }) =>
    Effect.succeed(
      Option.getOrElse(Option.fromUndefinedOr(input.retryAfter), () => DEFAULT_RETRY_DELAY),
    ),
  ),
);

/**
 * The task questions without `model`, for a config whose `judge.models` names fewer than two
 * models. `taskQuestions` cannot be built from fewer than two (`Decision.classify` throws), so
 * this builds it from two placeholder names and drops the one decision they reach.
 */
const placeholderTaskQuestions = taskQuestions({ a: "placeholder", b: "placeholder" });
const taskQuestionsWithoutModel = Decision.make({
  decisions: Struct.omit(placeholderTaskQuestions.decisions, ["model"]),
  input: placeholderTaskQuestions.input,
});

const isQuestion = Schema.is(JudgmentQuestion);
const isRate = Schema.is(RateAnswer);

/** A decision outcome as `judgments.json` stores it. A classify answer takes a rating's shape. */
const answerOf = (
  outcome: Result.Result<
    | Decision.ClassifyAnswer<string>
    | Decision.LocateAnswer
    | Decision.ProbabilityAnswer
    | Decision.RateAnswer<string>,
    Decision.Unanswered
  >,
): Answer =>
  Result.match(outcome, {
    onFailure: ({ description, reason }) => ({
      description: reason === "NoDistribution" ? `NoDistribution: ${description}` : description,
      unanswered: reason === "NoDistribution" ? "Invalid" : reason,
    }),
    onSuccess: (answer) =>
      Predicate.hasProperty(answer, "probability")
        ? { probability: answer.probability }
        : Predicate.hasProperty(answer, "label")
          ? Option.match(Option.fromUndefinedOr(answer.confidence), {
              onNone: () => ({ label: answer.label, probabilities: answer.probabilities }),
              onSome: (confidence) => ({
                confidence,
                label: answer.label,
                probabilities: answer.probabilities,
              }),
            })
          : {
              description: "a locate answer, which no judging question asks for",
              unanswered: "Invalid",
            },
  });

/** One target's request: its hash, the questions it asks, and the call that answers them. */
interface Request {
  readonly ask: Effect.Effect<
    ReadonlyArray<readonly [JudgmentQuestion, Answer]>,
    AiError.AiError,
    DecisionModel.DecisionModel
  >;
  readonly hash: Sha256Hex;
  readonly questions: ReadonlyArray<JudgmentQuestion>;
  readonly target: JudgmentTarget;
}

/**
 * The request for one target. The hash is the SHA-256, in hex, of the input encoded as JSON by
 * the definition's own input schema, so a field the schema leaves out does not change it.
 */
const requestOf = <
  S extends Schema.Codec<unknown, unknown>,
  D extends Record<string, Decision.Any>,
>(
  target: JudgmentTarget,
  definition: Decision.Definition<S, D>,
  input: S["Type"],
) =>
  Schema.encodeEffect(Schema.fromJsonString(definition.input))(input).pipe(
    Effect.mapError((error) => new JudgeError({ reason: error.message, target })),
    Effect.map((json): Request => ({
      ask: DecisionModel.decideSettled(definition, { input }).pipe(
        Effect.map(({ outcomes }) =>
          Array.filterMap(Record.toEntries(outcomes), ([question, outcome]) =>
            isQuestion(question)
              ? Result.succeed([question, answerOf(outcome)] as const)
              : Result.failVoid,
          ),
        ),
      ),
      hash: Sha256Hex.make(createHash("sha256").update(json).digest("hex")),
      questions: Array.filter(Record.keys(definition.decisions), isQuestion),
      target,
    })),
  );

/** The service: judges every target of `inputs`, keeping what `previous` already answered. */
export class Judge extends Context.Service<
  Judge,
  {
    readonly judge: (
      inputs: JudgingInputs,
      previous: Judgments,
    ) => Effect.Effect<Judgments, JudgeError>;
  }
>()("@cairn/cli/Judge") {
  /**
   * Judges with whichever `DecisionModel` the environment provides (`spec.judging.judge-service`).
   *
   * - Each target's input is hashed. When `previous` was answered by `judge.model` and holds a
   *   judgment with the target's hash for every question the target asks, those judgments are
   *   kept and the target is not asked. Only the questions it asks now are kept, and a `model`
   *   judgment only when its labels are the names in `judge.models` now.
   * - The rest go to `decideSettled`, one request per target with all its questions, four at a
   *   time. A task's `model` question is left out when `judge.models` names fewer than two.
   * - A rate-limit error is retried up to three times, each after the delay the provider gives.
   *   Any other `AiError`, or a fourth rate limit, is a `JudgeError` naming the target.
   * - A new judgment is round 1 with action `none`; its verdict and message are `verdictOf`'s,
   *   with no task to compare a `model` or `reasoning` answer with.
   */
  static readonly layerWith = (config: Pick<Config, "judge">) =>
    Layer.effect(
      Judge,
      Effect.gen(function* () {
        const decisionModel = yield* DecisionModel.DecisionModel;
        const tasks =
          Record.size(config.judge.models) >= 2
            ? taskQuestions(config.judge.models)
            : taskQuestionsWithoutModel;

        const requestsOf = (inputs: JudgingInputs) =>
          Effect.all(
            Array.flatten([
              Array.map(inputs.sections, ({ id, input }) =>
                requestOf({ id, kind: "section" }, sectionQuestions, input),
              ),
              Array.map(inputs.tasks, ({ id, input }) =>
                requestOf({ id, kind: "task" }, tasks, input),
              ),
              [requestOf({ kind: "stack" }, stackQuestions, inputs.stack)],
            ]),
          );

        /**
         * The catalog in `judge.models` is not in the hash, so a kept `model` judgment is current
         * only when its answer's labels are exactly the names `judge.models` gives now. Every
         * other judgment depends on the input alone.
         */
        const catalog = HashSet.fromIterable(Record.keys(config.judge.models));
        const isCurrent = (judgment: Judgment) =>
          judgment.question !== "model" ||
          (isRate(judgment.answer) &&
            Equal.equals(
              HashSet.fromIterable(Record.keys(judgment.answer.probabilities)),
              catalog,
            ));

        const judgmentsOf = (
          request: Request,
          answers: ReadonlyArray<readonly [JudgmentQuestion, Answer]>,
        ) =>
          Effect.map(DateTime.now, (at) =>
            Array.map(answers, ([question, answer]): Judgment => {
              const { message, verdict } = verdictOf(question, answer, config.judge);
              return {
                action: "none",
                answer,
                at,
                inputHash: request.hash,
                message,
                question,
                round: 1,
                target: request.target,
                verdict,
              };
            }),
          );

        const asked = (request: Request) =>
          request.ask.pipe(
            Effect.retry({
              schedule: providerDelay,
              times: RATE_LIMIT_RETRIES,
              while: isRateLimit,
            }),
            Effect.provideService(DecisionModel.DecisionModel, decisionModel),
            Effect.mapError(
              (error) => new JudgeError({ reason: error.message, target: request.target }),
            ),
            Effect.flatMap((answers) => judgmentsOf(request, answers)),
          );

        const judge = Effect.fn("Judge.judge")(function* (
          inputs: JudgingInputs,
          previous: Judgments,
        ) {
          const reusable = previous.model === config.judge.model ? previous.judgments : [];
          const requests = yield* requestsOf(inputs);
          const judgments = yield* Effect.forEach(
            requests,
            (request) => {
              const kept = Array.filter(
                reusable,
                (judgment) =>
                  judgment.inputHash === request.hash &&
                  nameOf(judgment.target) === nameOf(request.target) &&
                  Array.contains(request.questions, judgment.question) &&
                  isCurrent(judgment),
              );
              const covered = Array.every(request.questions, (question) =>
                Array.some(kept, (judgment) => judgment.question === question),
              );
              return covered ? Effect.succeed(kept) : asked(request);
            },
            { concurrency: CONCURRENT_REQUESTS },
          );
          return {
            judgments: Array.flatten(judgments),
            model: config.judge.model,
            version: 1,
          } satisfies Judgments;
        });

        return Judge.of({ judge });
      }),
    );

  /**
   * `layerWith` over the TypeSafe `DecisionModel` (`liveDecisionModel`). Building it without
   * `TYPESAFE_API_KEY` fails with a `JudgeError` that names the variable.
   */
  static readonly live = (config: Config) =>
    Judge.layerWith(config).pipe(
      Layer.provide(liveDecisionModel(config)),
      Layer.catchTag("ModelKeyError", (error) =>
        Layer.effect(Judge, Effect.fail(new JudgeError({ reason: error.reason }))),
      ),
    );
}
