import { TaskDraft, defaultConfig } from "@cairn/contract";
import type { Config } from "@cairn/contract";
import {
  Array,
  Context,
  Effect,
  FileSystem,
  Layer,
  Number,
  Option,
  Path,
  Predicate,
  Record,
  Result,
  Schema,
  String,
} from "effect";
import { AiError, LanguageModel } from "effect/ai";

/** Why a planner call failed: the model could not be reached, or its reply never decoded. */
export class PlannerError extends Schema.TaggedError<
  PlannerError,
  { readonly brand: unique symbol }
>()("PlannerError", {
  call: Schema.Literals(["spec", "tasks"]),
  reason: Schema.String,
}) {}

/**
 * What `tasks` asks the model for. A structured output is an object, so the drafts sit under a
 * key.
 */
export const TaskDrafts = Schema.Struct({ drafts: Schema.Array(TaskDraft) });

/** Why a prompt could not be made: its file could not be read, or its placeholders do not match. */
export class PromptError extends Schema.TaggedError<
  PromptError,
  { readonly brand: unique symbol }
>()("PromptError", {
  prompt: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `The ${this.prompt} prompt: ${this.reason}`;
  }
}

/** Splitting on a pattern with one capture group alternates text (even) and names (odd). */
const isSlot = (index: number) => Number.remainder(index, 2) === 1;

/** A `{{name}}` placeholder, with its name as the one capture group. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/u;

/**
 * Fills the `{{name}}` placeholders of a prompt template from `values`. A placeholder with no
 * value, and a value with no placeholder, are both a `PromptError`: a prompt that silently kept
 * `{{prd}}` or dropped a part of its input would go to the model unnoticed. The template is read
 * once, so a value that holds `{{...}}` or `$&` goes in as it is.
 */
export const fillPrompt = Effect.fn("fillPrompt")(function* (
  prompt: string,
  template: string,
  values: Readonly<Record<string, string>>,
) {
  const parts = String.split(template, PLACEHOLDER);
  const slots = Array.filterMap(parts, (part, index) =>
    isSlot(index) ? Result.succeed(part) : Result.failVoid,
  );
  const unfilled = Array.dedupe(Array.filter(slots, (name) => !Record.has(values, name)));
  const unused = Array.filter(Record.keys(values), (name) => !Array.contains(slots, name));
  if (Array.isReadonlyArrayNonEmpty(unfilled) || Array.isReadonlyArrayNonEmpty(unused)) {
    return yield* new PromptError({
      prompt,
      reason: Array.join(
        Array.appendAll(
          Array.map(unfilled, (name) => `the template has a placeholder ${name} with no value`),
          Array.map(unused, (name) => `a value was given for ${name}, which the template lacks`),
        ),
        "; ",
      ),
    });
  }
  return Array.join(
    Array.map(parts, (part, index) =>
      isSlot(index) ? Option.getOrElse(Record.get(values, part), () => part) : part,
    ),
    "",
  );
});

/** The prompt files of `packages/cli/prompts/`, next to `src/`. */
const promptUrl = (name: string) => new URL(`../prompts/${name}.md`, import.meta.url);

/**
 * The worked example of the spec prompt is this repository's own spec (`spec.planning.planner-service`).
 * It is read from `.cairn/spec.md` by its path from this file, not copied under `prompts/`, so the
 * example cannot drift from the spec. A known limit: the CLI has to run from a checkout of this
 * repository (it is a private package of this monorepo) or the file is missing, and the layer
 * fails with a `PromptError` naming it.
 */
const exampleUrl = new URL("../../../.cairn/spec.md", import.meta.url);

const readText = Effect.fn("readText")(
  function* (_prompt: string, url: URL) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* path.fromFileUrl(url);
    return yield* fs.readFileString(file);
  },
  (effect, prompt) =>
    Effect.mapError(effect, (error) => new PromptError({ prompt, reason: error.message })),
);

/** The prompts, each a function of what its call knows. */
export interface Prompts {
  /** Asks again after a reply failed to decode, with the decode error in the prompt. */
  readonly retry: (prompt: string, error: string) => Effect.Effect<string, PromptError>;
  readonly spec: (prd: string) => Effect.Effect<string, PromptError>;
  readonly tasks: (prd: string, spec: string) => Effect.Effect<string, PromptError>;
}

/** The models of the config's table, one bullet each, for the `tasks` prompt. */
const modelTable = (models: Readonly<Record<string, string>>) =>
  Array.join(
    Array.map(Record.toEntries(models), ([name, use]) => `- \`${name}\`: ${use}`),
    "\n",
  );

/**
 * Reads the prompt files and the worked example once, then makes the prompts. `models` is the
 * config's `judge.models` table, which the `tasks` prompt shows the model.
 */
export const loadPrompts = Effect.fn("loadPrompts")(function* (
  models: Readonly<Record<string, string>>,
) {
  const [retry, spec, tasks, example] = yield* Effect.all(
    [
      readText("retry", promptUrl("retry")),
      readText("spec", promptUrl("spec")),
      readText("tasks", promptUrl("tasks")),
      readText("spec example", exampleUrl),
    ],
    { concurrency: "unbounded" },
  );
  return {
    retry: (prompt, error) => fillPrompt("retry", retry, { error, prompt }),
    spec: (prd) => fillPrompt("spec", spec, { example, prd }),
    tasks: (prd, specText) =>
      fillPrompt("tasks", tasks, { models: modelTable(models), prd, spec: specText }),
  } satisfies Prompts;
});

/** The failures that mean the reply came back but did not decode, which a second try can fix. */
const isDecodeFailure = (error: AiError.AiError) =>
  Predicate.or(
    Predicate.isTagged("StructuredOutputError"),
    Predicate.isTagged("InvalidOutputError"),
  )(error.reason);

const failed = (call: PlannerError["call"]) => (error: AiError.AiError | PromptError) =>
  new PlannerError({ call, reason: error.message });

/**
 * Plans with a language model. The calls here are `spec` and `tasks`; `splitSection`,
 * `splitTask` and `index` join them as further members of the same service.
 */
export class Planner extends Context.Service<
  Planner,
  {
    /** The spec markdown for a PRD. */
    readonly spec: (prd: string) => Effect.Effect<string, PlannerError>;
    /** The task drafts for a PRD and its spec. */
    readonly tasks: (
      prd: string,
      spec: string,
    ) => Effect.Effect<ReadonlyArray<TaskDraft>, PlannerError>;
  }
>()("@cairn/cli/Planner") {
  /**
   * Plans with whichever `LanguageModel` the environment provides, and prompts that show the
   * model `config.judge.models`. It reads the prompt files when it is built, so a missing or
   * broken file fails there, before any call.
   */
  static readonly layerWith = (config: Pick<Config, "judge">) =>
    Layer.effect(
      Planner,
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel;
        const prompts = yield* loadPrompts(config.judge.models);

        const spec = Effect.fn("Planner.spec")(
          function* (prd: string) {
            const prompt = yield* prompts.spec(prd);
            const response = yield* LanguageModel.generateText({ prompt }).pipe(
              Effect.provideService(LanguageModel.LanguageModel, model),
            );
            return response.text;
          },
          Effect.mapError(failed("spec")),
        );

        // `generateObject` decodes the reply through its schema, so a reply that does not decode
        // fails with a decode failure we can tell from a transport one. That lets this call alone
        // decide to retry once, with the decode error in the prompt.
        const draftsFor = (prompt: string) =>
          LanguageModel.generateObject({
            objectName: "TaskDrafts",
            prompt,
            schema: TaskDrafts,
          }).pipe(
            Effect.provideService(LanguageModel.LanguageModel, model),
            Effect.map((response) => response.value.drafts),
          );

        const tasks = Effect.fn("Planner.tasks")(
          function* (prd: string, specText: string) {
            const prompt = yield* prompts.tasks(prd, specText);
            return yield* draftsFor(prompt).pipe(
              Effect.catchIf(isDecodeFailure, (error) =>
                prompts
                  .retry(prompt, error.message)
                  .pipe(Effect.flatMap((retryPrompt) => draftsFor(retryPrompt))),
              ),
            );
          },
          Effect.mapError(failed("tasks")),
        );

        return Planner.of({ spec, tasks });
      }),
    );

  /** `layerWith` the default config's model table. */
  static readonly layer = Planner.layerWith(defaultConfig);
}
