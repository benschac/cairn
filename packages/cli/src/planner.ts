import { TaskDraft } from "@cairn/contract";
import { Array, Context, Effect, Layer, Predicate, Schema } from "effect";
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

/**
 * The prompts. Each is a small function of what the call knows. They live apart from the calls so
 * that `packages/cli/prompts/` can replace them with files (`spec.planning.planner-service`).
 */
const prompts = {
  /** Asks again after a reply failed to decode, with the decode error in the prompt. */
  retry: (prompt: string, error: string) =>
    Array.join(
      [
        prompt,
        "Your previous reply was refused. Here is why:",
        error,
        "Reply again and fix every problem named above.",
      ],
      "\n\n",
    ),

  spec: (prd: string) =>
    Array.join(["Write the technical spec, in markdown, for this PRD.", "PRD:", prd], "\n\n"),

  tasks: (prd: string, spec: string) =>
    Array.join(
      [
        "Split this spec into tasks. Each task is one branch and one pull request.",
        "Name the other tasks a task depends on by their exact titles.",
        "PRD:",
        prd,
        "Spec:",
        spec,
      ],
      "\n\n",
    ),
};

/** The failures that mean the reply came back but did not decode, which a second try can fix. */
const isDecodeFailure = (error: AiError.AiError) =>
  Predicate.or(
    Predicate.isTagged("StructuredOutputError"),
    Predicate.isTagged("InvalidOutputError"),
  )(error.reason);

const failed = (call: PlannerError["call"]) => (error: AiError.AiError) =>
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
  /** Plans with whichever `LanguageModel` the environment provides. */
  static readonly layer = Layer.effect(
    Planner,
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel;

      const spec = Effect.fn("Planner.spec")(function* (prd: string) {
        const response = yield* LanguageModel.generateText({ prompt: prompts.spec(prd) }).pipe(
          Effect.provideService(LanguageModel.LanguageModel, model),
          Effect.mapError(failed("spec")),
        );
        return response.text;
      });

      // `generateObject` decodes the reply through its schema, so a reply that does not decode
      // fails with a decode failure we can tell from a transport one. That lets this call alone
      // decide to retry once, with the decode error in the prompt.
      const draftsFor = (prompt: string) =>
        LanguageModel.generateObject({ objectName: "TaskDrafts", prompt, schema: TaskDrafts }).pipe(
          Effect.provideService(LanguageModel.LanguageModel, model),
          Effect.map((response) => response.value.drafts),
        );

      const tasks = Effect.fn("Planner.tasks")(function* (prd: string, specText: string) {
        const prompt = prompts.tasks(prd, specText);
        return yield* draftsFor(prompt).pipe(
          Effect.catchIf(isDecodeFailure, (error) =>
            draftsFor(prompts.retry(prompt, error.message)),
          ),
          Effect.mapError(failed("tasks")),
        );
      });

      return Planner.of({ spec, tasks });
    }),
  );
}
