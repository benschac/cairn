import { Array, Effect, Number, Predicate, Schema } from "effect";

import { Slug } from "./manifest.ts";

/** The task categories the PRD names (`prd.outcomes.categories`), and what each is for. */
const CATEGORIES = Array.map(
  [
    { description: "Renames, moves and config changes", name: "mechanical" },
    { description: "New behaviour a person can use", name: "feature" },
    { description: "Interface and presentation", name: "ui" },
    { description: "Tests of existing behaviour", name: "test" },
    { description: "Data shapes, schemas and migrations", name: "schema" },
    { description: "Restructuring with no change in behaviour", name: "refactor" },
    { description: "Fixing a defect", name: "bugfix" },
    { description: "Documentation", name: "docs" },
  ],
  ({ description, name }) => ({ description, name: Schema.decodeSync(Slug)(name) }),
);

/** A category a plan's tasks may have (`spec.planning.task-categories`). */
export const Category = Schema.Struct({ description: Schema.String, name: Slug });
export type Category = typeof Category.Type;

/** The high-trust paths the PRD's human gate uses by default (`prd.human-gates`). */
const HUMAN_PATHS = [
  "**/migrations/**",
  "**/migrate/**",
  "**/auth/**",
  "**/payments/**",
  "infra/**",
  ".github/workflows/**",
];

/** A number in [0, 1], both ends included. */
const Unit = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));

/** A model name the manifest uses, and when to use it (`spec.contract.config`). */
const JUDGE_MODELS = {
  haiku: "Mechanical changes: a schema field, a rename, a command wired to existing code",
  sonnet: "Most tasks: a feature or service with its tests across a few files",
  opus: "Logic where a subtle bug costs a lot: derivation, ordering, redaction, concurrency",
};

/**
 * The planner's fields (`spec.contract.config`). `source` picks the agent CLI on the person's
 * machine or an API key. `cli` is read when `source` is "cli", and `provider` when it is "api".
 * `model` has no default: undefined leaves the choice to the CLI. `gatewayTokenEnv` names the
 * variable holding an AI Gateway token, never the token itself.
 */
const PlannerFields = Schema.Struct({
  baseUrl: Schema.optionalKey(Schema.String),
  cli: Schema.Literals(["claude", "codex"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("claude" as const)),
  ),
  gatewayTokenEnv: Schema.optionalKey(Schema.String),
  keyEnv: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  provider: Schema.Literals(["anthropic", "openai", "openrouter", "openai-compatible"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("anthropic" as const)),
  ),
  small: Schema.optionalKey(Schema.String),
  source: Schema.Literals(["cli", "api"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("cli" as const)),
  ),
});

/** `planner.model` is required when `planner.source` is "api". */
const apiNeedsModel = Schema.makeFilter<typeof PlannerFields.Type>(({ model, source }) =>
  source === "api" && Predicate.isUndefined(model)
    ? "planner.model is required when planner.source is api"
    : undefined,
);

/**
 * `planner.baseUrl` is required when the provider is "openai-compatible". The provider is only
 * read when `planner.source` is "api", so the rule applies only then: a CLI planner ignores it.
 */
const compatibleNeedsBaseUrl = Schema.makeFilter<typeof PlannerFields.Type>(
  ({ baseUrl, provider, source }) =>
    source === "api" && provider === "openai-compatible" && Predicate.isUndefined(baseUrl)
      ? "planner.baseUrl is required when planner.source is api and planner.provider is openai-compatible"
      : undefined,
);

/**
 * `planner.baseUrl` is required when `planner.gatewayTokenEnv` is set and the source is "api": the
 * token is for the gateway, and a request that goes straight to a provider must not carry it. A CLI
 * planner ignores the field.
 */
const gatewayTokenNeedsBaseUrl = Schema.makeFilter<typeof PlannerFields.Type>(
  ({ baseUrl, gatewayTokenEnv, source }) =>
    source === "api" && Predicate.isNotUndefined(gatewayTokenEnv) && Predicate.isUndefined(baseUrl)
      ? "planner.baseUrl is required when planner.source is api and planner.gatewayTokenEnv is set"
      : undefined,
);

const Planner = PlannerFields.pipe(
  Schema.check(apiNeedsModel),
  Schema.check(compatibleNeedsBaseUrl),
  Schema.check(gatewayTokenNeedsBaseUrl),
);

/**
 * The judge's fields (`spec.contract.config`). `gatewayTokenEnv` names the variable holding a
 * Cloudflare AI Gateway token, never the token itself.
 */
const JudgeFields = Schema.Struct({
  baseUrl: Schema.optionalKey(Schema.String),
  flag: Unit.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0.5))),
  maxRounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2)),
  ),
  gatewayTokenEnv: Schema.optionalKey(Schema.String),
  minConfidence: Unit.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0.5))),
  model: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("jev-1.14.0"))),
  models: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(JUDGE_MODELS)),
  ),
  pass: Unit.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0.8))),
});

/** `judge.pass` must be greater than `judge.flag`. */
const passAboveFlag = Schema.makeFilter<{ readonly flag: number; readonly pass: number }>(
  ({ flag, pass }) =>
    Number.isGreaterThan(flag)(pass) ? undefined : "judge.pass must be greater than judge.flag",
);

/**
 * `judge.baseUrl` is required when `judge.gatewayTokenEnv` is set: the token is for the gateway,
 * and a request that goes straight to TypeSafe must not carry it.
 */
const judgeGatewayNeedsBaseUrl = Schema.makeFilter<typeof JudgeFields.Type>(
  ({ baseUrl, gatewayTokenEnv }) =>
    Predicate.isNotUndefined(gatewayTokenEnv) && Predicate.isUndefined(baseUrl)
      ? "judge.baseUrl is required when judge.gatewayTokenEnv is set"
      : undefined,
);

const Judge = JudgeFields.pipe(Schema.check(passAboveFlag), Schema.check(judgeGatewayNeedsBaseUrl));

/**
 * `.cairn/config.json`. Every field has a default, so `{}` decodes to the defaults, and a
 * missing file is read as `{}`.
 */
export const Config = Schema.Struct({
  categories: Schema.Array(Category).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(CATEGORIES)),
  ),
  humanPaths: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(HUMAN_PATHS)),
  ),
  judge: Judge.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  planner: Planner.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  redact: Schema.Struct({
    deny: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([])),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  version: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
});
export type Config = typeof Config.Type;

export const ConfigJson = Schema.fromJsonString(Config);

/** The config a missing `.cairn/config.json` decodes to. */
export const defaultConfig: Config = Schema.decodeSync(Config)({});
