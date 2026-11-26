import { TaskStatus, type Trace } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { vi } from "vitest";
import { Array, Effect, Fiber, Option, Ref, Result, Schema, Stream, Struct } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/http";
import { Subscription, expect, given, role, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import demoTraceJson from "../src/demo-trace.json" with { type: "json" };
import { demoTrace } from "../src/demo.ts";
import {
  TRACE_POLL_INTERVAL,
  TraceNotDecoded,
  TraceNotLoaded,
  decodeTrace,
  describeTraceError,
  pollTrace,
} from "../src/load.ts";
import { Message } from "../src/message.ts";
import { traceMessages } from "../src/subscription/trace.ts";
import { init } from "../src/init.ts";
import { TraceData } from "../src/model.ts";
import { update } from "../src/update.ts";
import { view } from "../src/view/view.ts";
import { mounted } from "./fixtures.ts";

const columns = [
  expect(role("region", { name: "PRD" })).toExist(),
  expect(role("region", { name: "Spec" })).toExist(),
  expect(role("region", { name: "Stacks" })).toExist(),
];
const withTrace = (trace: TraceData) => modifyFields(init().model, { trace: () => trace });

it("init starts loading", () => {
  assert(init().model.trace).toEqual(TraceData.Loading());
});

it.effect.prop(
  "decodeTrace refuses a task status the contract does not name, and says why",
  [Schema.String.check(Schema.makeFilter((status: string) => !Schema.is(TaskStatus)(status)))],
  ([status]) =>
    Effect.gen(function* () {
      const corrupted = Struct.evolve(demoTraceJson, {
        tasks: Array.map((task) => Struct.evolve(task, { status: () => status })),
      });
      const errors = yield* Effect.forEach([corrupted, null, {}], (input) =>
        Effect.flip(decodeTrace(input)),
      );
      assert(Array.every(errors, Schema.is(TraceNotDecoded))).toBe(true);
      assert(describeTraceError(Option.getOrThrow(Array.head(errors)))).toContain("did not decode");
    }),
);

it("a trace that never arrived is described as not loaded", () => {
  assert(describeTraceError(new TraceNotLoaded({ cause: "offline" }))).toBe(
    "The demo trace did not load: offline",
  );
});

it("a fresh model shows loading and no columns", () => {
  scene(
    { update, view },
    given(init().model),
    expect(selector("[data-loading]")).toExist(),
    expect(selector("[data-reader]")).toBeAbsent(),
    expect(role("alert")).toBeAbsent(),
  );
});

it("a loaded trace renders the columns and no loading state", () => {
  scene(
    { update, view },
    given(withTrace(TraceData.Success({ data: demoTrace }))),
    mounted,
    ...columns,
    expect(selector("[data-loading]")).toBeAbsent(),
    expect(role("alert")).toBeAbsent(),
  );
});

it("a failed reload shows the alert above the last good trace", () => {
  scene(
    { update, view },
    given(withTrace(TraceData.Stale({ data: demoTrace, error: "network down" }))),
    mounted,
    expect(role("alert")).toHaveText("network down"),
    ...columns,
  );
});

it("a failed first load shows the alert only", () => {
  scene(
    { update, view },
    given(withTrace(TraceData.Failure({ error: "boom" }))),
    expect(role("alert")).toHaveText("boom"),
    expect(selector("[data-reader]")).toBeAbsent(),
    expect(selector("[data-loading]")).toBeAbsent(),
  );
});

// POLLING

/** What a scripted `cairn serve` answers: a status, an ETag and a body, or a dropped connection. */
type Answer =
  | { readonly status: number; readonly etag?: string; readonly body: unknown }
  | "offline";

const NOT_MODIFIED = 304;
const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const otherJson = Struct.evolve(demoTraceJson, { baseBranch: () => "elsewhere" });

/**
 * Poll against a server that gives each request the next of `answers`, for as many answers as
 * there are, two seconds apart on the test clock. Returns what the viewer heard and the
 * `If-None-Match` each request carried.
 */
const polled = (answers: ReadonlyArray<Answer>) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make(Array.empty<Option.Option<string>>());
    const context = yield* Effect.context();
    const run = Effect.runPromiseWith(context);
    const fetchNext = (_input: unknown, request?: RequestInit) =>
      run(
        Effect.gen(function* () {
          const asked = yield* Ref.get(sent);
          yield* Ref.set(
            sent,
            Array.append(
              asked,
              Option.fromNullOr(new Headers(request?.headers).get("if-none-match")),
            ),
          );
          const answer = yield* Effect.fromOption(Array.get(answers, Array.length(asked))).pipe(
            Effect.orDie,
          );
          if (answer === "offline") {
            return yield* Effect.die(new TypeError("Failed to fetch"));
          }
          const body = yield* Effect.orDie(encodeBody(answer.body));
          return new Response(answer.status === NOT_MODIFIED ? null : body, {
            headers: answer.etag === undefined ? {} : { etag: answer.etag },
            status: answer.status,
          });
        }),
      );
    vi.stubGlobal("location", new URL("http://cairn.test/"));
    const heard = yield* Ref.make(Array.empty<Result.Result<Trace, string>>());
    const fiber = yield* pollTrace(TRACE_POLL_INTERVAL).pipe(
      Stream.provide(FetchHttpClient.layer),
      Stream.provideService(FetchHttpClient.Fetch, fetchNext),
      Stream.runForEach((result) => Ref.update(heard, Array.append(result))),
      Effect.forkChild,
    );
    // The stream never ends: let the clock run to the last answer, then stop it.
    yield* Effect.forEach(Array.drop(answers, 1), () =>
      Effect.andThen(Effect.yieldNow, TestClock.adjust("2 seconds")),
    );
    yield* Fiber.interrupt(fiber);
    return { heard: yield* Ref.get(heard), sent: yield* Ref.get(sent) };
  }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));

const baseBranches = Array.map((result: Result.Result<Trace, string>) =>
  Result.isSuccess(result) ? result.success.baseBranch : result.failure,
);

it.effect(
  "a 200 sends the trace, a 304 sends nothing, and each request carries the last ETag",
  () =>
    Effect.gen(function* () {
      const { heard, sent } = yield* polled([
        { body: demoTraceJson, etag: '"a"', status: 200 },
        { body: null, status: 304 },
        { body: otherJson, etag: '"b"', status: 200 },
        { body: null, status: 304 },
      ]);
      assert(baseBranches(heard)).toEqual([demoTrace.baseBranch, "elsewhere"]);
      assert(sent).toEqual([
        Option.none(),
        Option.some('"a"'),
        Option.some('"a"'),
        Option.some('"b"'),
      ]);
    }),
);

it.effect("a failed poll is sent as the error and the next request starts from no ETag", () =>
  Effect.gen(function* () {
    const { heard, sent } = yield* polled([
      { body: demoTraceJson, etag: '"a"', status: 200 },
      { body: null, status: 500 },
      "offline",
      { body: { nonsense: true }, etag: '"x"', status: 200 },
      { body: demoTraceJson, etag: '"a"', status: 200 },
    ]);
    assert(Array.map(heard, Result.isSuccess)).toEqual([true, false, false, false, true]);
    assert(baseBranches(heard)[1]).toBe("The trace did not load: HTTP 500");
    assert(baseBranches(heard)[2]).toContain("did not load");
    assert(baseBranches(heard)[3]).toContain("did not decode");
    assert(sent).toEqual([
      Option.none(),
      Option.some('"a"'),
      Option.none(),
      Option.none(),
      Option.none(),
    ]);
  }),
);

it.effect("the demo build polls nothing", () =>
  Effect.map(Stream.runCollect(traceMessages(true)), (messages) => assert(messages).toEqual([])),
);

it("polled messages keep the columns up, and a polled error shows above them", () => {
  scene(
    { update, view },
    given(withTrace(TraceData.Success({ data: demoTrace }))),
    mounted,
    Subscription.emit(
      Message.SettledLoadTrace({
        result: Result.succeed({ ...demoTrace, baseBranch: "elsewhere" }),
      }),
    ),
    expect(role("alert")).toBeAbsent(),
    ...columns,
    Subscription.emit(
      Message.SettledLoadTrace({ result: Result.fail("The trace did not load: HTTP 500") }),
    ),
    expect(role("alert")).toHaveText("The trace did not load: HTTP 500"),
    ...columns,
  );
});
