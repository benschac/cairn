import type { Config as CairnConfig } from "@cairn/contract";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import {
  OpenAiClient as OpenAiCompatClient,
  OpenAiLanguageModel as OpenAiCompatLanguageModel,
} from "@effect/ai-openai-compat";
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Array, Config, Effect, FileSystem, Layer, Match, Option, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import type { HttpClient } from "effect/http";
import { LanguageModel } from "effect/ai";
import type { ChildProcessSpawner } from "effect/process";

import { CliNotFound, layer as cliLanguageModel } from "./cli-model.ts";

/** The environment variable the Anthropic provider's key is read from unless `planner.keyEnv` names another. */
export const ANTHROPIC_API_KEY = "ANTHROPIC_API_KEY";

/** The variable each `api` provider's key is read from unless `planner.keyEnv` names another (`spec.models`). */
export const DEFAULT_KEY_VARIABLES: Readonly<Record<CairnConfig["planner"]["provider"], string>> = {
  anthropic: ANTHROPIC_API_KEY,
  openai: "OPENAI_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * The environment variable the planner's key is read from, which the `Redactor` adds to its secret
 * set. None for the `cli` source, which reads no key.
 */
export const plannerKeyVariable = (config: CairnConfig) =>
  Match.value(config.planner.source).pipe(
    Match.when("cli", () => Option.none<string>()),
    Match.when("api", () =>
      Option.some(
        Option.getOrElse(
          Option.fromUndefinedOr(config.planner.keyEnv),
          () => DEFAULT_KEY_VARIABLES[config.planner.provider],
        ),
      ),
    ),
    Match.exhaustive,
  );

/**
 * The key a model needs could not be read. The message names the variable and never holds a
 * value, so `cairn plan` can print it and stop before it changes a file.
 */
export class ModelKeyError extends Schema.TaggedError<
  ModelKeyError,
  { readonly brand: unique symbol }
>()("ModelKeyError", {
  reason: Schema.String,
  variable: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}

/** The configured planner cannot be built: its model is not set. */
export class ModelUnavailable extends Schema.TaggedError<
  ModelUnavailable,
  { readonly brand: unique symbol }
>()("ModelUnavailable", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}

/** The planner's calls (`spec.planning.planner-service`). */
export const PlannerCall = Schema.Literals([
  "spec",
  "sections",
  "tasks",
  "splitSection",
  "splitTask",
  "index",
]);
export type PlannerCall = typeof PlannerCall.Type;

/** The calls that may use the cheaper `planner.small` model. */
const SMALL_CALLS: ReadonlyArray<PlannerCall> = ["index", "splitSection", "splitTask"];

/**
 * The model name for a call: `planner.small` for the small calls when it is set, and
 * `planner.model` otherwise. None leaves the choice to the CLI.
 */
export const modelNameFor = (config: CairnConfig, call: PlannerCall) =>
  Option.orElse(
    Array.contains(SMALL_CALLS, call)
      ? Option.fromUndefinedOr(config.planner.small)
      : Option.none(),
    () => Option.fromUndefinedOr(config.planner.model),
  );

/** A layer that fails when it is built. */
const unavailable = (reason: string) =>
  Layer.effect(LanguageModel.LanguageModel, Effect.fail(new ModelUnavailable({ reason })));

const missingKey = (variable: string) =>
  new ModelKeyError({
    reason: `${variable} is not set, or could not be read. The planner needs it to call its model: set it in your environment, or set planner.source to cli in .cairn/config.json.`,
    variable,
  });

/** The variable a provider's key is read from: `planner.keyEnv`, or the provider's own. */
const keyVariable = (config: CairnConfig) =>
  Option.getOrElse(
    Option.fromUndefinedOr(config.planner.keyEnv),
    () => DEFAULT_KEY_VARIABLES[config.planner.provider],
  );

/** The key from the environment: a `ModelKeyError` naming the variable when it is not there. */
const requiredKey = (variable: string) =>
  Config.Redacted(variable).pipe(Effect.mapError(() => missingKey(variable)));

/** The key from the environment when it is there: a local endpoint needs none. */
const optionalKey = (variable: string) =>
  Config.Redacted(variable).pipe(
    Config.option,
    Effect.mapError(() => missingKey(variable)),
    Effect.map(Option.getOrUndefined),
  );

/**
 * The `api` providers (`planner.provider`): the provider's `model(name)` over its client. A client
 * reads its key, `planner.keyEnv` or the provider's own variable, when its layer is built, so a
 * command that never provides the layer never reads it, and building one without the key fails with
 * a `ModelKeyError`; `openai-compatible` treats a missing key as fine. `planner.baseUrl`, when set,
 * is each client's `apiUrl`, which routes calls through a proxy such as Cloudflare AI Gateway; the
 * provider's own host is the default, and `openai-compatible` has none, so the config requires it.
 */
const apiModel = (config: CairnConfig, model: Option.Option<string>) => {
  const variable = keyVariable(config);
  const apiUrl = config.planner.baseUrl;
  return Option.match(model, {
    onNone: () => unavailable("planner.model is required when planner.source is api"),
    onSome: (name) =>
      Match.value(config.planner.provider).pipe(
        Match.when("anthropic", () =>
          AnthropicLanguageModel.model(name).pipe(
            Layer.provide(
              Layer.unwrap(
                requiredKey(variable).pipe(
                  Effect.map((apiKey) => AnthropicClient.layer({ apiKey, apiUrl })),
                ),
              ),
            ),
          ),
        ),
        Match.when("openai", () =>
          OpenAiLanguageModel.model(name).pipe(
            Layer.provide(
              Layer.unwrap(
                requiredKey(variable).pipe(
                  Effect.map((apiKey) => OpenAiClient.layer({ apiKey, apiUrl })),
                ),
              ),
            ),
          ),
        ),
        Match.when("openrouter", () =>
          OpenRouterLanguageModel.model(name).pipe(
            Layer.provide(
              Layer.unwrap(
                requiredKey(variable).pipe(
                  Effect.map((apiKey) => OpenRouterClient.layer({ apiKey, apiUrl })),
                ),
              ),
            ),
          ),
        ),
        Match.when("openai-compatible", () =>
          OpenAiCompatLanguageModel.model(name).pipe(
            Layer.provide(
              Layer.unwrap(
                optionalKey(variable).pipe(
                  Effect.map((apiKey) => OpenAiCompatClient.layer({ apiKey, apiUrl })),
                ),
              ),
            ),
          ),
        ),
        Match.exhaustive,
      ),
  });
};

/** What a planner layer can fail with, and what it needs to be built. */
type PlannerLayer = Layer.Layer<
  LanguageModel.LanguageModel,
  CliNotFound | ModelKeyError | ModelUnavailable,
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
>;

/**
 * The `LanguageModel` the planner uses for one call, from `planner.source`:
 *
 * - `cli`, the default: the person's agent CLI (`cli-model.ts`). It reads no key and looks for the
 *   CLI only when this layer is built. `claude` and `codex` both run without tools
 *   (`cli-model.ts` says how codex is isolated).
 * - `api`: the layer of `planner.provider`: `anthropic`, `openai`, `openrouter` or `openai-compatible`.
 *
 * The model name is `planner.small` for the small calls and `planner.model` otherwise
 * (`modelNameFor`). `environment` adds variables to the CLI's environment; a test sets `PATH`.
 */
export const languageModelFor = (
  config: CairnConfig,
  call: PlannerCall,
  environment?: Readonly<Record<string, string>>,
): PlannerLayer => {
  const model = modelNameFor(config, call);
  return Match.value(config.planner.source).pipe(
    Match.when("cli", () =>
      Match.value(config.planner.cli).pipe(
        Match.whenOr("claude", "codex", (cli) =>
          cliLanguageModel({ cli, environment, model: Option.getOrUndefined(model) }),
        ),
        Match.exhaustive,
      ),
    ),
    Match.when("api", () => apiModel(config, model)),
    Match.exhaustive,
  );
};

/** The model for the calls that write: `languageModelFor` for `spec`, which `tasks` shares. */
export const languageModel = (config: CairnConfig) => languageModelFor(config, "spec");

/** `languageModel` over `fetch`: what the CLI composition root provides. */
export const liveLanguageModel = (config: CairnConfig) =>
  languageModel(config).pipe(Layer.provide(FetchHttpClient.layer));

/** The environment variable the Judge's key is read from (`spec.models`). */
export const TYPESAFE_API_KEY = "TYPESAFE_API_KEY";

/**
 * The `DecisionModel` the Judge uses: `TypeSafeDecisionModel.model(judge.model)` over a TypeSafe
 * client, with `judge.model` passed as written (it defaults to the pinned `jev-1.14.0`, never
 * `jev-latest`). The client reads `TYPESAFE_API_KEY` with `Config.Redacted` when this layer is
 * built, so a command that never provides it never reads the key, and building it without the key
 * fails with a `ModelKeyError`. `judge.baseUrl`, when set, is the client's `apiUrl`, which routes
 * calls through a proxy; TypeSafe's own host is the default.
 */
export const decisionModel = (config: CairnConfig) =>
  TypeSafeDecisionModel.model(config.judge.model).pipe(
    Layer.provide(
      Layer.unwrap(
        Config.Redacted(TYPESAFE_API_KEY).pipe(
          Effect.mapError(
            () =>
              new ModelKeyError({
                reason: `${TYPESAFE_API_KEY} is not set, or could not be read. The judge needs it to call its model: set it in your environment.`,
                variable: TYPESAFE_API_KEY,
              }),
          ),
          Effect.map((apiKey) => TypeSafeClient.layer({ apiKey, apiUrl: config.judge.baseUrl })),
        ),
      ),
    ),
  );

/** `decisionModel` over `fetch`: what the CLI composition root provides. */
export const liveDecisionModel = (config: CairnConfig) =>
  decisionModel(config).pipe(Layer.provide(FetchHttpClient.layer));
