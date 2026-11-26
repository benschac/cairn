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

/** The text parts of a message, one after another. */
const textPartsOf = (parts: ReadonlyArray<Prompt.UserMessagePart | Prompt.AssistantMessagePart>) =>
  Array.join(
    Array.getSomes(
      Array.map(parts, (part) => (part.type === "text" ? Option.some(part.text) : Option.none())),
    ),
    "",
  );

/**
 * What a message says. The planner sends system and user messages, and a chat sends the model's
 * earlier replies back as assistant messages; tool messages say nothing here.
 */
const said = Match.type<Prompt.Message>().pipe(
  Match.when({ role: "system" }, (message) => message.content),
  Match.when({ role: "user" }, (message) => textPartsOf(message.content)),
  Match.when({ role: "assistant" }, (message) => textPartsOf(message.content)),
  Match.when({ role: "tool" }, () => ""),
  Match.exhaustive,
);

/** Each message of a prompt as its role and what it says, so a test can read a conversation. */
export const turnsOf = (prompt: Prompt.Prompt) =>
  Array.map(prompt.content, (message) => ({ role: message.role, text: said(message) }));

/** The text of every message in a prompt, one after another. */
const textOf = (prompt: Prompt.Prompt) => Array.join(Array.map(prompt.content, said), "\n");

/** The script a test plays: it hands out the next reply and remembers each prompt it was given. */
export class Script extends Context.Service<
  Script,
  {
    readonly next: (prompt: Prompt.Prompt) => Effect.Effect<string, AiError.AiError>;
    /** The prompts the model was given, in order, each as the text of its messages. */
    readonly prompts: Effect.Effect<ReadonlyArray<string>>;
    /** The prompts the model was given, in order, with their messages and roles. */
    readonly requests: Effect.Effect<ReadonlyArray<Prompt.Prompt>>;
  }
>()("@cairn/cli/test/Script") {
  static readonly layer = (replies: ReadonlyArray<Reply>) =>
    Layer.effect(
      Script,
      Effect.gen(function* () {
        const requests = yield* Ref.make<ReadonlyArray<Prompt.Prompt>>([]);
        const next = (prompt: Prompt.Prompt) =>
          Ref.modify(requests, (seen) => [Array.length(seen), Array.append(seen, prompt)]).pipe(
            Effect.flatMap((call) =>
              Array.get(replies, call).pipe(Option.getOrElse(() => Effect.fail(exhausted(call)))),
            ),
          );
        return Script.of({
          next,
          prompts: Effect.map(Ref.get(requests), Array.map(textOf)),
          requests: Ref.get(requests),
        });
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
          script.next(options.prompt).pipe(Effect.map((text) => [{ text, type: "text" as const }])),
        streamText: () => Stream.empty,
      });
    }),
  ).pipe(Layer.provideMerge(Script.layer(replies)));
