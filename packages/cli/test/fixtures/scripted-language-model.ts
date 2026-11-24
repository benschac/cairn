import { Array, Context, Effect, Layer, Match, Option, Ref, Stream } from "effect";
import { AiError, LanguageModel } from "effect/ai";
import type { Prompt } from "effect/ai";

/** What the scripted model answers one call with: the reply text, or the failure of the call. */
export type Reply = Effect.Effect<string, AiError.AiError>;

/** A model call that fails the way a provider does when it cannot be reached. */
export const unreachable: Reply = Effect.fail(
  AiError.make({
    method: "generateText",
    module: "ScriptedLanguageModel",
    reason: new AiError.RateLimitError({}),
  }),
);

const exhausted = (call: number) =>
  AiError.make({
    method: "generateText",
    module: "ScriptedLanguageModel",
    reason: new AiError.InvalidRequestError({
      description: `The script has no reply for call ${call}`,
    }),
  });

/** What a message says. The planner sends system and user messages; the others say nothing here. */
const said = Match.type<Prompt.Message>().pipe(
  Match.when({ role: "system" }, (message) => message.content),
  Match.when({ role: "user" }, (message) =>
    Array.join(
      Array.getSomes(
        Array.map(message.content, (part) =>
          part.type === "text" ? Option.some(part.text) : Option.none(),
        ),
      ),
      "",
    ),
  ),
  Match.when({ role: "assistant" }, () => ""),
  Match.when({ role: "tool" }, () => ""),
  Match.exhaustive,
);

/** The text of every message in a prompt, one after another. */
const textOf = (prompt: Prompt.Prompt) => Array.join(Array.map(prompt.content, said), "\n");

/** The script a test plays: it hands out the next reply and remembers each prompt it was given. */
export class Script extends Context.Service<
  Script,
  {
    readonly next: (prompt: string) => Effect.Effect<string, AiError.AiError>;
    /** The prompts the model was given, in order. */
    readonly prompts: Effect.Effect<ReadonlyArray<string>>;
  }
>()("@cairn/cli/test/Script") {
  static readonly layer = (replies: ReadonlyArray<Reply>) =>
    Layer.effect(
      Script,
      Effect.gen(function* () {
        const prompts = yield* Ref.make<ReadonlyArray<string>>([]);
        const next = (prompt: string) =>
          Ref.modify(prompts, (seen) => [Array.length(seen), Array.append(seen, prompt)]).pipe(
            Effect.flatMap((call) =>
              Array.get(replies, call).pipe(Option.getOrElse(() => Effect.fail(exhausted(call)))),
            ),
          );
        return Script.of({ next, prompts: Ref.get(prompts) });
      }),
    );
}

/**
 * A `LanguageModel` that replays `replies` in order and never touches the network or a key. A
 * call past the last reply fails, so a test sees a call it did not expect. `Script` reports the
 * prompts the model was given.
 */
export const scripted = (replies: ReadonlyArray<Reply>) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const script = yield* Script;
      return yield* LanguageModel.make({
        generateText: (options) =>
          script
            .next(textOf(options.prompt))
            .pipe(Effect.map((text) => [{ text, type: "text" as const }])),
        streamText: () => Stream.empty,
      });
    }),
  ).pipe(Layer.provideMerge(Script.layer(replies)));
