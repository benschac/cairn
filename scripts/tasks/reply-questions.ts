// Whether a board thread's latest reply ends the thread, asked of a decision model. The wording lives here; the
// thresholds are code. Without a judge, or when it is unsure or fails, report.ts's regex decides (see `isOpen`).

import { Config } from "@cairn/contract";
import {
  Array,
  Duration,
  Effect,
  Layer,
  Number,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
} from "effect";
import { Decision, DecisionModel } from "effect/ai";

import { type Decided, type Thread, threadTasks } from "./report.ts";

export const ReplyInput = Schema.Struct({ reply: Schema.String, tasks: Schema.String });

export const replyQuestions = Decision.make({
  decisions: {
    ended: Decision.probability({
      criteria: {
        false:
          "The author reports progress and keeps working on the tasks. Examples: t30 landed; continuing on t31. PR open: https://example.test/1. Rebased, running the checks.",
        true: "The author says they have stopped working on the tasks, whether done, dropped, blocked or handed to someone else. Examples: Stopping here, blocked on t40. Landed: abc1234. Abandoned, the plan changed.",
      },
      instructions:
        "In `reply`, the author says they have stopped working on `tasks`. A reply that mentions another task landing, or says it is not stopping, is progress.",
    }),
    // Asked in the same request. The report lists only open threads, so it has no line for a reason and does not read it.
    why: Decision.classify({
      criteria: {
        abandoned: "The author dropped the tasks without finishing them.",
        blocked: "The author is waiting on something outside the tasks.",
        handed_off: "The author passed the tasks to another person or agent.",
        landed: "The tasks' pull requests merged into main.",
      },
      instructions: "Why did the author stop working on `tasks`?",
    }),
  },
  input: ReplyInput,
});

// Yes at 0.7 or above, no at 0.3 or below, unsure between (TypeSafe's starting point for a probability).
const YES = 0.7;
const NO = 0.3;
const CONCURRENT_REQUESTS = 4;
const REQUEST_TIMEOUT = Duration.seconds(20);
const JUDGING_DEADLINE = Duration.seconds(60);
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config));

// Yes or no when the probability is past a threshold; none between them.
const verdict = (probability: number): Option.Option<boolean> =>
  Number.isGreaterThanOrEqualTo(probability, YES)
    ? Option.some(true)
    : Number.isLessThanOrEqualTo(probability, NO)
      ? Option.some(false)
      : Option.none();

// Some when the model is sure; none when it is unsure, the question went unanswered, the request failed or it took
// too long.
const closedBy = (
  thread: Thread,
): Effect.Effect<Option.Option<boolean>, never, DecisionModel.DecisionModel> =>
  Option.match(Option.fromNullOr(thread.last), {
    onNone: () => Effect.succeedNone,
    onSome: (last) =>
      DecisionModel.decideSettled(replyQuestions, {
        input: { reply: last.text, tasks: Array.join(threadTasks(thread), ", ") },
      }).pipe(
        // A stalled gateway must not hold the report.
        Effect.timeoutOption(REQUEST_TIMEOUT),
        Effect.map(
          Option.flatMap(({ outcomes }) =>
            Result.match(outcomes.ended, {
              onFailure: () => Option.none<boolean>(),
              onSuccess: ({ probability }) => verdict(probability),
            }),
          ),
        ),
        Effect.orElseSucceed(() => Option.none<boolean>()),
      ),
  });

/**
 * The judge's config from the text of .cairn/config.json. A missing file is the defaults; any other read error, or a
 * file that does not decode, fails, so no judge is built from settings the file did not give (a judge built from the
 * defaults would send board text to TypeSafe directly, past the gateway the file names).
 */
export const loadConfig = <E extends { readonly reason: unknown }>(
  read: Effect.Effect<string, E>,
) =>
  read.pipe(
    Effect.catchIf(
      (error) => Predicate.isTagged("NotFound")(error.reason),
      () => Effect.succeed("{}"),
    ),
    Effect.flatMap(decodeConfig),
  );

/**
 * What the judge decided about each thread, one request per thread, four at a time, all within `JUDGING_DEADLINE`.
 * A thread it is unsure of, fails on or has not answered by then is left out, so the regex decides it. `unavailable`
 * says why the judge, or the environment it reads its key from, could not be built, once.
 */
export const judgeThreads = <
  E extends { readonly message: string },
  F extends { readonly message: string },
  R,
>(
  threads: ReadonlyArray<Thread>,
  judge: Layer.Layer<DecisionModel.DecisionModel, E>,
  environment: Layer.Layer<never, F, R>,
): Effect.Effect<{ decided: Array<Decided>; unavailable: Option.Option<string> }, never, R> =>
  Effect.gen(function* () {
    const answered = yield* Ref.make(Array.empty<Decided>());
    yield* Effect.forEach(
      threads,
      (thread) =>
        Effect.flatMap(
          closedBy(thread),
          Option.match({
            onNone: () => Effect.void,
            onSome: (closed) => Ref.update(answered, Array.append({ thread, closed })),
          }),
        ),
      { concurrency: CONCURRENT_REQUESTS, discard: true },
    ).pipe(Effect.timeoutOption(JUDGING_DEADLINE), Effect.provide(judge));
    return { decided: yield* Ref.get(answered), unavailable: Option.none<string>() };
  }).pipe(
    Effect.provide(environment),
    Effect.catch((error: E | F) =>
      Effect.succeed({ decided: Array.empty<Decided>(), unavailable: Option.some(error.message) }),
    ),
  );
