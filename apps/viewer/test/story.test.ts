import { ParticipantId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { vi } from "vitest";
import { Command, given, message, model, story } from "foldkit/story";

import { demoTrace } from "../src/demo.ts";
import { init } from "../src/init.ts";
import { loadDemoTrace } from "../src/load.ts";
import { Message } from "../src/message.ts";
import { PresenceConnection, TraceData } from "../src/model.ts";
import { Node } from "../src/trace.ts";
import { LoadTrace, update } from "../src/update.ts";

const settled = (result: Result.Result<typeof demoTrace, string>) =>
  Message.SettledLoadTrace({ result });

/** The Commands init returns are not the result of a Message, so this step seeds the story with them. */
const started = (simulation: Parameters<ReturnType<typeof given>>[0]) => {
  const initial = init();
  return { ...simulation, commands: initial.commands ?? [], model: initial.model };
};

/** Runs a story in the demo build, the only one whose init loads the bundled trace. */
const inDemoBuild = (run: () => void) => {
  vi.stubEnv("PROD", true);
  try {
    run();
  } finally {
    vi.unstubAllEnvs();
  }
};

const ordinary = init().model;

// LOADING

it("in the demo build init issues LoadTrace, and a failed first load is a Failure", () =>
  inDemoBuild(() => {
    story(
      update,
      started,
      Command.expectExact(LoadTrace),
      Command.resolve(LoadTrace, settled(Result.fail("boom"))),
      model((next) => assert(next.trace).toEqual(TraceData.Failure({ error: "boom" }))),
    );
  }));

it("a successful first load is a Success", () =>
  inDemoBuild(() => {
    story(
      update,
      started,
      Command.resolve(LoadTrace, settled(Result.succeed(demoTrace))),
      model((next) => assert(next.trace).toEqual(TraceData.Success({ data: demoTrace }))),
    );
  }));

it.prop(
  "a failed reload keeps the last good trace, and a later load clears the error",
  [Schema.String],
  ([error]) =>
    inDemoBuild(() => {
      story(
        update,
        started,
        Command.resolve(LoadTrace, settled(Result.succeed(demoTrace))),
        message(settled(Result.fail(error))),
        model((next) => assert(next.trace).toEqual(TraceData.Stale({ data: demoTrace, error }))),
        message(settled(Result.succeed(demoTrace))),
        model((next) => assert(next.trace).toEqual(TraceData.Success({ data: demoTrace }))),
      );
    }),
  // Only the error is generated, and each run compares the whole demo trace twice, so a few runs cover it.
  { arbitrary: { runs: 25 } },
);

it("outside the demo build init loads nothing, so the first poll is the first load and the bundled trace cannot replace a live one", () => {
  story(
    update,
    started,
    Command.expectNone(),
    model((next) => assert(next.trace).toEqual(TraceData.Loading())),
    message(settled(Result.succeed(demoTrace))),
    model((next) => assert(next.trace).toEqual(TraceData.Success({ data: demoTrace }))),
  );
});

it.effect("the integration of loadDemoTrace decodes the bundled demo file", () =>
  Effect.map(loadDemoTrace, (trace) => assert(trace).toEqual(demoTrace)),
);

// HOVER

it("leaving a node with nothing hovered leaves nothing hovered", () => {
  story(
    update,
    given(ordinary),
    message(Message.LeftNode()),
    model((next) => assert(next.maybeHovered).toEqual(Option.none())),
  );
});

it.prop("hovering a node then leaving it clears the hover", { node: Node }, ({ node }) => {
  story(
    update,
    given(ordinary),
    message(Message.HoveredNode({ node })),
    model((next) => assert(next.maybeHovered).toEqual(Option.some(node))),
    message(Message.LeftNode()),
    model((next) => assert(next.maybeHovered).toEqual(Option.none())),
  );
});

// PRESENCE

it("the presence connection opens, then closes and forgets the room", () => {
  const you = ParticipantId.make("p1");
  story(
    update,
    given(ordinary),
    model((next) => assert(next.presenceConnection).toEqual(PresenceConnection.Connecting())),
    message(Message.OpenedPresence()),
    model((next) => assert(next.presenceConnection).toEqual(PresenceConnection.Connected())),
    message(
      Message.ReceivedPresence({
        presence: {
          participants: [{ id: you, kind: "human", name: "Ada", reading: Option.none() }],
          you,
        },
      }),
    ),
    model((next) => assert(next.maybeYou).toEqual(Option.some(you))),
    message(Message.ClosedPresence()),
    model((next) => {
      assert(next.presenceConnection).toEqual(PresenceConnection.Disconnected());
      assert(next.maybeYou).toEqual(Option.none());
      assert(next.participants).toEqual([]);
    }),
  );
});
