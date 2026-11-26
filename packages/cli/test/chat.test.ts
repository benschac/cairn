import { expect, it } from "@effect/vitest";
import { Array, Effect, Ref, Result, Schema } from "effect";
import { Chat } from "effect/ai";

import { branch } from "../src/chat.ts";
import { Script, scripted, turnsOf } from "./fixtures/scripted-language-model.ts";

/** The reviews of the talk's example, each asked in a branch of one chat. */
const TOPICS = ["security", "performance", "design"];

/** Two turns of the provided chat: the topic, then a follow-up that needs the first reply. */
const review = (topic: string) =>
  Effect.flatMap(Chat.Chat, (chat) =>
    chat
      .generateText({ prompt: topic })
      .pipe(Effect.andThen(chat.generateText({ prompt: `${topic}, again` }))),
  );

/** The user turns a branch for `topic` may have sent after the trunk's: its own, and nothing else. */
const ownTurns = (earlier: string, topic: string) => [
  [earlier, topic],
  [earlier, topic, `${topic}, again`],
];

it.effect.prop(
  "concurrent branches of a chat each see its turns and only their own, and the chat keeps just its turns",
  [Schema.NonEmptyString, Schema.NonEmptyString],
  ([opening, earlier]) =>
    Effect.gen(function* () {
      const trunk = yield* Chat.fromPrompt([{ content: opening, role: "system" }]);
      yield* trunk.generateText({ prompt: earlier });
      const before = yield* Ref.get(trunk.history);
      yield* Effect.forEach(TOPICS, (topic) => branch(review(topic)), {
        concurrency: "unbounded",
      }).pipe(Effect.provideService(Chat.Chat, trunk));
      const after = yield* Ref.get(trunk.history);
      expect(after).toEqual(before);

      const requests = yield* Script.use((script) => script.requests);
      const [first, ...branched] = Array.map(requests, turnsOf);
      expect(first).toEqual([
        { role: "system", text: opening },
        { role: "user", text: earlier },
      ]);
      expect(Array.length(branched)).toBe(2 * Array.length(TOPICS));
      Array.forEach(branched, (turns) => {
        // Each branch starts from the trunk as it was: the opening, the earlier turn and its reply.
        expect(Array.take(turns, 3)).toEqual([
          { role: "system", text: opening },
          { role: "user", text: earlier },
          { role: "assistant", text: "reply 0" },
        ]);
        const users = Array.filterMap(turns, ({ role, text }) =>
          role === "user" ? Result.succeed(text) : Result.failVoid,
        );
        expect(Array.flatMap(TOPICS, (topic) => ownTurns(earlier, topic))).toContainEqual(users);
      });
    }).pipe(
      Effect.provide(
        scripted(
          Array.makeBy(1 + 2 * Array.length(TOPICS), (call) => Effect.succeed(`reply ${call}`)),
        ),
      ),
    ),
);
