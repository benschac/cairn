import type { Config as CairnConfig } from "@cairn/contract";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
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

/** The configured planner cannot be built: its provider has no layer yet, or its model is not set. */
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

/**
 * The Anthropic provider (`planner.provider` "anthropic"): `AnthropicLanguageModel.model(name)`
 * over an Anthropic client. The client reads its key, `planner.keyEnv` or `ANTHROPIC_API_KEY`, when
 * this layer is built, so a command that never provides the layer never reads it, and building it
 * without the key fails with a `ModelKeyError`. `planner.baseUrl`, when set, is the client's
 * `apiUrl`, which routes calls through a proxy such as Cloudflare AI Gateway; the provider's own
 * host is the default.
 */
const anthropic = (config: CairnConfig, model: Option.Option<string>) => {
  const variable = Option.getOrElse(
    Option.fromUndefinedOr(config.planner.keyEnv),
    () => ANTHROPIC_API_KEY,
  );
  return Option.match(model, {
    onNone: () => unavailable("planner.model is required when planner.source is api"),
    onSome: (name) =>
      AnthropicLanguageModel.model(name).pipe(
        Layer.provide(
          Layer.unwrap(
            Config.Redacted(variable).pipe(
              Effect.mapError(() => missingKey(variable)),
              Effect.map((apiKey) =>
                AnthropicClient.layer({ apiKey, apiUrl: config.planner.baseUrl }),
              ),
            ),
          ),
        ),
      ),
  });
};

/** A provider whose package a later task adds (t106): selecting it fails with a typed error. */
const notYet = (provider: string) =>
  unavailable(
    `The ${provider} provider is not available yet. Use planner.provider anthropic, or set planner.source to cli in .cairn/config.json.`,
  );

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
 * - `api`: the layer of `planner.provider`. Only `anthropic` is built so far.
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
    Match.when("api", () =>
      Match.value(config.planner.provider).pipe(
        Match.when("anthropic", () => anthropic(config, model)),
        Match.whenOr("openai", "openrouter", "openai-compatible", (provider) => notYet(provider)),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
};

/** The model for the calls that write: `languageModelFor` for `spec`, which `tasks` shares. */
export const languageModel = (config: CairnConfig) => languageModelFor(config, "spec");

/** `languageModel` over `fetch`: what the CLI composition root provides. */
export const liveLanguageModel = (config: CairnConfig) =>
  languageModel(config).pipe(Layer.provide(FetchHttpClient.layer));
