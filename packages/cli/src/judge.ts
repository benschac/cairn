import { createHash } from "node:crypto";

import { JudgmentQuestion, JudgmentTarget, Sha256Hex } from "@cairn/contract";
import type { Config, Judgment, Judgments } from "@cairn/contract";
import {
  TaskJudgingInput,
  prdSectionQuestions,
  sectionQuestions,
  stackQuestions,
  taskQuestionsFor,
  verdictOf,
} from "@cairn/core";
import type { Answer, JudgingInputs } from "@cairn/core";
import {
  Array,
  Context,
  DateTime,
  Duration,
  Effect,
  Function,
  Layer,
  Option,
  Order,
  Predicate,
  Record,
  Result,
  Schedule,
  Schema,
  Tuple,
} from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";

import { judgingAvailable, liveDecisionModel } from "./models.ts";

/**
 * Judging failed. With a `target`, the decision model failed on that target's request; without
 * one, the model could not be built, such as when `TYPESAFE_API_KEY` is missing and `judge.gatewayTokenEnv` is not set.
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
  prd: ({ id }) => `PRD section ${id}`,
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

const isQuestion = Schema.is(JudgmentQuestion);

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

type Models = Config["judge"]["models"];
type Categories = Config["categories"];

/** `judge.models` as a task's hash covers it: `[name, description]` pairs, sorted by name. */
const CatalogJson = Schema.Array(Schema.Tuple([Schema.String, Schema.String]));

/**
 * What a task's hash is taken over: its input and the catalogs its `model` and `category`
 * questions read.
 */
const TaskHashJson = Schema.fromJsonString(
  Schema.Struct({ categories: CatalogJson, input: TaskJudgingInput, models: CatalogJson }),
);

const catalogOf = (models: Models) =>
  Array.sortWith(Record.toEntries(models), Tuple.get(0), Order.String);

/** `config.categories` as a record of name to description, for the `category` question. */
const categoryRecordOf = (categories: Categories): Models =>
  Record.fromEntries(
    Array.map(categories, ({ description, name }) => [name, description] as const),
  );

/** Which questions a call asks of each target: the ones `asks` holds true, every one by default. */
export interface JudgeOptions {
  readonly asks?: Predicate.Predicate<JudgmentQuestion>;
}

/**
 * The request for one target, whose hash is the SHA-256, in hex, of `json`. `json` is encoded by
 * schemas, so a field they leave out does not change the hash, and neither does `asks`. The
 * request asks only the questions `asks` keeps; with none it asks nothing.
 */
/** The kinds of decision the judging definitions ask; none locates. */
type Asked = Decision.Classify<string> | Decision.Probability | Decision.Rate<string>;

const requestOf = <S extends Schema.Codec<unknown, unknown>, D extends Record<string, Asked>>(
  target: JudgmentTarget,
  definition: Decision.Definition<S, D>,
  input: S["Type"],
  json: Effect.Effect<string, Schema.SchemaError>,
  asks: Predicate.Predicate<JudgmentQuestion>,
) => {
  const keeps = (key: string): key is JudgmentQuestion => isQuestion(key) && asks(key);
  const questions = Array.filter(Record.keys(definition.decisions), keeps);
  // `Decision.make` throws on no decisions, so a target left with none asks nothing.
  const asked = (narrowed: Decision.Definition<S, Record<string, Asked>>) =>
    DecisionModel.decideSettled(narrowed, { input }).pipe(
      Effect.map(({ outcomes }) =>
        Array.filterMap(Record.toEntries(outcomes), ([question, outcome]) =>
          isQuestion(question)
            ? Result.succeed([question, answerOf(outcome)] as const)
            : Result.failVoid,
        ),
      ),
    );
  const ask = Array.isReadonlyArrayEmpty(questions)
    ? Effect.succeed<ReadonlyArray<readonly [JudgmentQuestion, Answer]>>([])
    : asked(
        Array.length(questions) === Record.size(definition.decisions)
          ? definition
          : Decision.make({
              decisions: Record.filter(definition.decisions, (_, key) => keeps(key)),
              input: definition.input,
            }),
      );
  return json.pipe(
    Effect.mapError((error) => new JudgeError({ reason: error.message, target })),
    Effect.map((encodedJson): Request => ({
      ask,
      hash: Sha256Hex.make(createHash("sha256").update(encodedJson).digest("hex")),
      questions,
      target,
    })),
  );
};

/** The JSON of `input` as `schema` encodes it. */
const encoded = <S extends Schema.Codec<unknown, unknown>>(schema: S, input: S["Type"]) =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(input);

/**
 * One request per spec section, then per task, then per PRD section, then the stack, each asking
 * what `asks` keeps.
 */
const requestsOf = (
  inputs: JudgingInputs,
  models: Models,
  categories: Categories,
  asks: Predicate.Predicate<JudgmentQuestion> = Function.constTrue,
) => {
  const categoryRecord = categoryRecordOf(categories);
  const tasks = taskQuestionsFor(models, categoryRecord);
  const catalog = catalogOf(models);
  const categoryCatalog = catalogOf(categoryRecord);
  return Effect.all(
    Array.flatten([
      Array.map(inputs.sections, ({ id, input }) =>
        requestOf(
          { id, kind: "section" },
          sectionQuestions,
          input,
          encoded(sectionQuestions.input, input),
          asks,
        ),
      ),
      Array.map(inputs.tasks, ({ id, input }) =>
        requestOf(
          { id, kind: "task" },
          tasks,
          input,
          Schema.encodeEffect(TaskHashJson)({
            categories: categoryCatalog,
            input,
            models: catalog,
          }),
          asks,
        ),
      ),
      Array.map(inputs.prdSections, ({ id, input }) =>
        requestOf(
          { id, kind: "prd" },
          prdSectionQuestions,
          input,
          encoded(prdSectionQuestions.input, input),
          asks,
        ),
      ),
      [
        requestOf(
          { kind: "stack" },
          stackQuestions,
          inputs.stack,
          encoded(stackQuestions.input, inputs.stack),
          asks,
        ),
      ],
    ]),
  );
};

/**
 * The `inputHash` the judge gives each target of `inputs` under `judge.models` and
 * `categories`, in the order
 * `inputsOf` gives the targets. A judgment whose `inputHash` differs from its target's here is
 * stale: the judge would ask that target again.
 *
 * - A spec section's, a PRD section's or the stack's hash is the SHA-256, in hex, of its input
 *   encoded as JSON by its definition's input schema (`SectionJudgingInput`,
 *   `PrdSectionJudgingInput`, `StackJudgingInput`).
 * - A task's hash is the SHA-256, in hex, of
 *   `{"categories": [[name, description], ...], "input": ..., "models": [[name, description], ...]}`
 *   encoded as JSON: its `TaskJudgingInput` and every entry of `config.categories` and of
 *   `judge.models`, each sorted by name. The descriptions are the `category` and `model`
 *   questions' criteria, so any change to either, a description alone included, makes every task
 *   be asked again. A catalog is covered even when it names fewer than two entries and its
 *   question is not asked.
 */
export const inputHashesOf = (
  inputs: JudgingInputs,
  config: { readonly categories: Categories; readonly judge: Pick<Config["judge"], "models"> },
): Effect.Effect<
  ReadonlyArray<{ readonly hash: Sha256Hex; readonly target: JudgmentTarget }>,
  JudgeError
> =>
  Effect.map(
    requestsOf(inputs, config.judge.models, config.categories),
    Array.map(({ hash, target }) => ({ hash, target })),
  );

/** A request's answers as new judgments: round 1, action `none`, verdicts from `verdictOf`. */
const judgmentsOf = (
  request: Request,
  answers: ReadonlyArray<readonly [JudgmentQuestion, Answer]>,
  thresholds: Config["judge"],
) =>
  Effect.map(DateTime.now, (at) =>
    Array.map(answers, ([question, answer]): Judgment => {
      const { message, verdict } = verdictOf(question, answer, thresholds);
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

/** The service: judges every target of `inputs`, keeping what `previous` already answered. */
export class Judge extends Context.Service<
  Judge,
  {
    readonly judge: (
      inputs: JudgingInputs,
      previous: Judgments,
      options?: JudgeOptions,
    ) => Effect.Effect<Judgments, JudgeError>;
  }
>()("@cairn/cli/Judge") {
  /**
   * Judges with whichever `DecisionModel` the environment provides (`spec.judging.judge-service`).
   *
   * - Each target is hashed as `inputHashesOf` says; a task's hash covers `judge.models` and
   *   `config.categories` too.
   *   When `previous` was answered by `judge.model` and holds a judgment with the target's hash
   *   for every question the target asks, those judgments are kept and the target is not asked.
   *   Only the questions it asks now are kept.
   * - The rest go to `decideSettled`, one request per target with all its questions, four at a
   *   time. With `options.asks`, a target is asked, and kept, only the questions it holds true;
   *   a target left with none is not asked. A task's `model` question is left out when `judge.models` names fewer than two, and its
   *   `category` question when `config.categories` does.
   * - A rate-limit error is retried up to three times, each after the delay the provider gives.
   *   Any other `AiError`, or a fourth rate limit, is a `JudgeError` naming the target.
   * - A new judgment is round 1 with action `none`; its verdict and message are `verdictOf`'s,
   *   with no task to compare a `model` or `reasoning` answer with.
   */
  static readonly layerWith = (config: Pick<Config, "categories" | "judge">) =>
    Layer.effect(
      Judge,
      Effect.gen(function* () {
        const decisionModel = yield* DecisionModel.DecisionModel;

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
            Effect.flatMap((answers) => judgmentsOf(request, answers, config.judge)),
          );

        const judge = Effect.fn("Judge.judge")(function* (
          inputs: JudgingInputs,
          previous: Judgments,
          { asks = Function.constTrue }: JudgeOptions = {},
        ) {
          const reusable = previous.model === config.judge.model ? previous.judgments : [];
          const requests = yield* requestsOf(inputs, config.judge.models, config.categories, asks);
          const judgments = yield* Effect.forEach(
            requests,
            (request) => {
              const kept = Array.filter(
                reusable,
                (judgment) =>
                  judgment.inputHash === request.hash &&
                  nameOf(judgment.target) === nameOf(request.target) &&
                  Array.contains(request.questions, judgment.question),
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
   * `TYPESAFE_API_KEY` and no `judge.gatewayTokenEnv` fails with a `JudgeError` that names the
   * variable; a `judge.gatewayTokenEnv` variable that is not set fails naming it.
   */
  static readonly live = (config: Config) =>
    Judge.layerWith(config).pipe(
      Layer.provide(liveDecisionModel(config)),
      Layer.catchTag("ModelKeyError", (error) =>
        Layer.effect(Judge, Effect.fail(new JudgeError({ reason: error.reason }))),
      ),
    );

  /**
   * `live` when `TYPESAFE_API_KEY` or `judge.gatewayTokenEnv` is set, and no `Judge` at all
   * otherwise. Which layer is provided is the whole switch (`spec.refactors.optional-services`):
   * `cairn plan` asks for the judge with `Effect.serviceOption` and skips its checkpoints when
   * there is none, so it keeps no flag of its own to agree with this one.
   */
  static readonly whenConfigured = (config: Config) =>
    Layer.unwrap(
      Effect.map(judgingAvailable(config), (available) =>
        available ? Judge.live(config) : Layer.empty,
      ),
    );
}
