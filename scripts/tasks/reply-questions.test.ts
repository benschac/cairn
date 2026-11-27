import assert from "node:assert/strict";
import { test } from "node:test";

import { TestClock } from "effect/testing";
import {
  Array,
  DateTime,
  Duration,
  Exit,
  Fiber,
  Effect,
  Layer,
  Option,
  Order,
  Predicate,
  Record,
  Schema,
} from "effect";
import { AiError, DecisionModel } from "effect/ai";

import { Manifest } from "@cairn/contract";
import { PlatformError } from "effect";
import { classify, type Decided, type Evidence, isOpenIn, Thread } from "./report.ts";
import { judgeThreads, loadConfig } from "./reply-questions.ts";

const decodeThread = Schema.decodeUnknownSync(Thread);
const thread = (last: string, text = "Starting t1") =>
  decodeThread({
    message: { text, labels: {}, createdAt: "2026-11-24T11:00:00.000Z" },
    last: { text: last, createdAt: "2026-11-24T11:30:00.000Z" },
  });

// A decision model that answers `ended` with the probability its script gives for the reply, or fails.
const scripted = (probability: (reply: string) => number | "fail", seen: Array<string> = []) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: (options) => {
        const reply =
          Predicate.hasProperty(options.state, "reply") && Predicate.isString(options.state.reply)
            ? options.state.reply
            : "";
        seen.push(reply);
        const say = probability(reply);
        return say === "fail"
          ? Effect.fail(
              AiError.make({
                method: "decide",
                module: "test",
                reason: new AiError.InvalidRequestError({ description: "Bad request" }),
              }),
            )
          : Effect.succeed({
              answers: Record.map(options.decisions, (decision) =>
                Predicate.isTagged(decision, "Probability")
                  ? { _tag: "Probability" as const, probability: say }
                  : {
                      _tag: "Classify" as const,
                      confidence: 1,
                      label: "landed",
                      probabilities: { abandoned: 0, blocked: 0, handed_off: 0, landed: 1 },
                    },
              ),
              usage: { inputTokens: 1, outputTokens: 1 },
            });
      },
    }),
  );

const failing = (error: { readonly message: string }) =>
  Layer.effect(DecisionModel.DecisionModel, Effect.fail(error));

const NOW = DateTime.makeUnsafe("2026-11-24T12:00:00.000Z");
const evidence = (decided: ReadonlyArray<Decided>): Evidence => ({
  trailers: [],
  merged: [],
  open: [],
  worktrees: [],
  threads: [],
  decided,
  now: NOW,
});

// What the report does with a thread after the judge has looked at it.
const openAfter = (
  judge: Layer.Layer<DecisionModel.DecisionModel, { readonly message: string }>,
  each: Thread,
) =>
  Effect.map(judgeThreads([each], judge, Layer.empty), ({ decided }) =>
    isOpenIn(evidence(decided), each),
  );

await test("a yes closes a thread the regex calls open, and a no keeps open a thread the regex calls closed", async () => {
  const progress = thread("Rebased; waiting on review.");
  const stopped = thread("Stopping here.");
  assert.equal(
    await Effect.runPromise(
      openAfter(
        scripted(() => 0.95),
        progress,
      ),
    ),
    false,
  );
  assert.equal(
    await Effect.runPromise(
      openAfter(
        scripted(() => 0.05),
        stopped,
      ),
    ),
    true,
  );
});

await test("unsure, a failed request and no judge fall back to the regex", async () => {
  const progress = thread("Rebased; waiting on review.");
  const stopped = thread("Stopping here.");
  const fallbacks = [
    scripted(() => 0.5),
    scripted(() => "fail"),
    failing({ message: "TYPESAFE_API_KEY is not set" }),
  ];
  const results = await Effect.runPromise(
    Effect.forEach(fallbacks, (judge) =>
      Effect.all([openAfter(judge, progress), openAfter(judge, stopped)]),
    ),
  );
  assert.deepEqual(results, [
    [true, false],
    [true, false],
    [true, false],
  ]);
});

await test("a request that never answers is left to the regex once its time is up", async () => {
  const never = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({ decide: () => Effect.never }),
  );
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        judgeThreads([thread("Stopping.")], never, Layer.empty),
      );
      yield* TestClock.adjust(Duration.minutes(1));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  assert.deepEqual(out.decided, []);
  assert.equal(Option.isNone(out.unavailable), true);
});

await test("no judge says why once and decides nothing", async () => {
  const out = await Effect.runPromise(
    judgeThreads([thread("a"), thread("b")], failing({ message: "no key" }), Layer.empty),
  );
  assert.deepEqual(out.decided, []);
  assert.deepEqual(out.unavailable, Option.some("no key"));
  const live = await Effect.runPromise(
    judgeThreads(
      [thread("a")],
      scripted(() => 0.9),
      Layer.empty,
    ),
  );
  assert.equal(Option.isNone(live.unavailable), true);
});

await test("one request per thread, with the reply and the tasks it claims", async () => {
  const seen: Array<string> = [];
  const threads = Array.makeBy(6, (index) => thread(`reply ${index}`));
  const { decided } = await Effect.runPromise(
    judgeThreads(
      threads,
      scripted(() => 0.9, seen),
      Layer.empty,
    ),
  );
  assert.equal(decided.length, 6);
  assert.deepEqual(
    Array.sort(seen, Order.String),
    Array.makeBy(6, (index) => `reply ${index}`),
  );
});

await test("the report frees a task whose only claim the judge ended, and keeps one the regex would have closed", () => {
  const manifest = Schema.decodeSync(Manifest)({
    baseBranch: "main",
    feature: "demo",
    tasks: [
      {
        branch: "demo/01-work",
        commits: [],
        dependsOn: [],
        files: [],
        humanGate: { reasons: [], required: false },
        id: "t1",
        model: "sonnet",
        parent: null,
        prdSections: ["prd.demo"],
        reasoning: "low",
        sessions: [],
        specSections: ["spec.demo"],
        status: "pending",
        title: "Build t1",
        worktree: null,
      },
    ],
    version: 1,
  });
  const claim = thread("t1 is done on my side.");
  const stateOf = (decided: ReadonlyArray<Decided>) =>
    Array.map(classify(manifest, { ...evidence(decided), threads: [claim] }), (row) => row.state);
  assert.deepEqual(stateOf([]), ["claimed"]);
  assert.deepEqual(stateOf([{ thread: claim, closed: true }]), ["ready"]);
  const stopping = thread("Stopping: no, the fix is small.");
  assert.equal(isOpenIn(evidence([]), stopping), false);
  assert.equal(isOpenIn(evidence([{ thread: stopping, closed: false }]), stopping), true);
});

const readError = (tag: "NotFound" | "PermissionDenied") =>
  PlatformError.systemError({ _tag: tag, method: "readFileString", module: "FileSystem" });

await test("a missing config is the defaults; an unreadable or malformed one is an error, never the defaults", async () => {
  const defaults = await Effect.runPromise(loadConfig(Effect.fail(readError("NotFound"))));
  assert.equal(defaults.judge.gatewayTokenEnv, undefined);
  const gateway = JSON.stringify({
    judge: { baseUrl: "https://gateway.example/v1", gatewayTokenEnv: "TOKEN" },
  });
  const given = await Effect.runPromise(loadConfig(Effect.succeed(gateway)));
  assert.equal(given.judge.gatewayTokenEnv, "TOKEN");
  const denied = await Effect.runPromiseExit(
    loadConfig(Effect.fail(readError("PermissionDenied"))),
  );
  assert.equal(Exit.isFailure(denied), true);
  const malformed = await Effect.runPromiseExit(loadConfig(Effect.succeed("{not json")));
  assert.equal(Exit.isFailure(malformed), true);
});

await test("an environment that cannot be loaded leaves every thread to the regex and says why", async () => {
  const out = await Effect.runPromise(
    judgeThreads(
      [thread("Landed: abc1234")],
      scripted(() => 0.9),
      failing({ message: ".env is not readable" }),
    ),
  );
  assert.deepEqual(out.decided, []);
  assert.deepEqual(out.unavailable, Option.some(".env is not readable"));
});

await test("the judging deadline keeps what was answered and leaves the rest to the regex", async () => {
  const slow = Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: (options) => {
        const reply =
          Predicate.hasProperty(options.state, "reply") && Predicate.isString(options.state.reply)
            ? options.state.reply
            : "";
        return reply === "quick"
          ? Effect.succeed({
              answers: Record.map(options.decisions, () => ({
                _tag: "Probability" as const,
                probability: 0.95,
              })),
              usage: { inputTokens: 1, outputTokens: 1 },
            })
          : Effect.sleep(Duration.minutes(10)).pipe(Effect.andThen(Effect.never));
      },
    }),
  );
  const quick = thread("quick");
  const out = await Effect.runPromise(
    Effect.gen(function* () {
      // Forty slow threads at four at a time, each inside its own 20 seconds, would run past 60 seconds.
      const fiber = yield* Effect.forkChild(
        judgeThreads(
          Array.prepend(
            Array.makeBy(40, (index) => thread(`slow ${index}`)),
            quick,
          ),
          slow,
          Layer.empty,
        ),
      );
      yield* TestClock.adjust(Duration.seconds(61));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  assert.equal(out.decided.length, 1);
  assert.equal(out.decided[0]?.closed, true);
});
