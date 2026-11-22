import { TaskStatus, type Trace } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Result, Schema, Struct } from "effect";
import { expect, given, role, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import demoTraceJson from "../src/demo-trace.json" with { type: "json" };
import { demoTrace } from "../src/demo.ts";
import { TraceNotDecoded, TraceNotLoaded, decodeTrace, describeTraceError } from "../src/load.ts";
import { LoadTrace, Message, init, update, view } from "../src/main.ts";
import { TraceData } from "../src/model.ts";
import { mounted } from "./fixtures.ts";

const columns = [
  expect(selector('[data-column="prd"]')).toExist(),
  expect(selector('[data-column="spec"]')).toExist(),
  expect(selector('[data-column="stacks"]')).toExist(),
];
const withTrace = (trace: TraceData) => modifyFields(init().model, { trace: () => trace });
const settle = (result: Result.Result<Trace, string>) => Message.SettledLoadTrace({ result });

it("init starts loading and issues LoadTrace", () => {
  const started = init();
  assert(started.model.trace).toEqual(TraceData.Loading());
  assert(
    Option.map(
      Option.fromUndefinedOr(started.commands),
      Array.map((command) => command.name),
    ),
  ).toEqual(Option.some([LoadTrace.name]));
});

it.effect("LoadTrace settles with the bundled demo trace", () =>
  Effect.map(LoadTrace().effect, (message) =>
    assert(message).toEqual(settle(Result.succeed(demoTrace))),
  ),
);

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

it.prop(
  "a failed load keeps the last good trace, and a later load clears the error",
  [Schema.String],
  ([error]) => {
    const good = update(init().model, settle(Result.succeed(demoTrace))).model;
    const failed = update(good, settle(Result.fail(error))).model;
    assert(failed.trace).toEqual(TraceData.Stale({ data: demoTrace, error }));
    assert(update(init().model, settle(Result.fail(error))).model.trace).toEqual(
      TraceData.Failure({ error }),
    );
    assert(update(failed, settle(Result.succeed(demoTrace))).model.trace).toEqual(
      TraceData.Success({ data: demoTrace }),
    );
  },
);

it("a fresh model shows loading and no columns", () => {
  scene(
    { update, view },
    given(init().model),
    expect(selector("[data-loading]")).toExist(),
    expect(selector("[data-column]")).toBeAbsent(),
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
    expect(selector("[data-column]")).toBeAbsent(),
    expect(selector("[data-loading]")).toBeAbsent(),
  );
});