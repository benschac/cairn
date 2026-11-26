import { Effect, Ref } from "effect";
import { Chat } from "effect/ai";

/**
 * Runs an effect in a branch of the current conversation: a new `Chat` that starts from the
 * history the current one has now. The branch sees every turn before it and adds its own turns to
 * itself only, so effects run as branches of one chat, even concurrently, never see each other's
 * turns, and the chat they branch from keeps just the turns it had.
 *
 * Because the conversation is a service, branching it is providing a different one, and
 * `Effect.provideServiceEffect` scopes the replacement to the one effect, so the code that uses the
 * chat never knows. From Harry Solovay's talk "Advanced Effect Design Patterns" at Effect Miami 3,
 * chapter IV, "Branching conversations": https://youtu.be/_tSGby_q890
 */
export const branch = Effect.provideServiceEffect(
  Chat.Chat,
  Effect.gen(function* () {
    const chat = yield* Chat.Chat;
    const history = yield* Ref.get(chat.history);
    return yield* Chat.fromPrompt(history);
  }),
);

branch satisfies <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Chat.Chat | R>;
