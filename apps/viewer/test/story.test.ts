import { ParticipantId } from "@cairn/contract";
import { Story } from "@effect/ui/testing";
import { expect as assert, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { vi } from "vitest";

import { Viewer, viewerBridge } from "../src/app.ts";
import { demoTrace } from "../src/demo.ts";
import { loadDemoTrace } from "../src/load.ts";
import { Message } from "../src/message.ts";
import { PresenceConnection, TraceData } from "../src/model.ts";
import { Node } from "../src/trace.ts";
import { LoadTrace } from "../src/update.ts";
import { ordinary, viewerProps } from "./fixtures.ts";

const settled = (result: Result.Result<typeof demoTrace, string>) =>
  Message.SettledLoadTrace({ result });

const loadTrace = viewerBridge.commandOf(LoadTrace);

/**
 * A story on `Viewer`. Its `init` returns the Commands the Foldkit `init` returned, so they are
 * pending on the cursor from the start, as `started` seeded them.
 */
const started = Story.make(Viewer, viewerProps);

/** Starts a story in the demo build, the only one whose init loads the bundled trace. */
const startedInDemoBuild = Effect.acquireUseRelease(
  Effect.sync(() => vi.stubEnv("PROD", true)),
  () => started,
  () => Effect.sync(() => vi.unstubAllEnvs()),
);

// LOADING

it.effect("in the demo build init issues LoadTrace, and a failed first load is a Failure", () =>
  Effect.gen(function* () {
    const s = yield* startedInDemoBuild;
    s.expectExact(loadTrace)
      .resolve(loadTrace, settled(Result.fail("boom")))
      .check(({ model }) => assert(model.trace).toEqual(TraceData.Failure({ error: "boom" })));
  }),
);

it.effect("a successful first load is a Success", () =>
  Effect.gen(function* () {
    const s = yield* startedInDemoBuild;
    s.resolve(loadTrace, settled(Result.succeed(demoTrace))).check(({ model }) =>
      assert(model.trace).toEqual(TraceData.Success({ data: demoTrace })),
    );
  }),
);

it.effect.prop(
  "a failed reload keeps the last good trace, and a later load clears the error",
  [Schema.String],
  ([error]) =>
    Effect.gen(function* () {
      const s = yield* startedInDemoBuild;
      s.resolve(loadTrace, settled(Result.succeed(demoTrace)))
        .send(settled(Result.fail(error)))
        .check(({ model }) =>
          assert(model.trace).toEqual(TraceData.Stale({ data: demoTrace, error })),
        )
        .send(settled(Result.succeed(demoTrace)))
        .check(({ model }) => assert(model.trace).toEqual(TraceData.Success({ data: demoTrace })));
    }),
  // Only the error is generated, and each run compares the whole demo trace twice, so a few runs cover it.
  { arbitrary: { runs: 25 } },
);

it.effect(
  "outside the demo build init loads nothing, so the first poll is the first load and the bundled trace cannot replace a live one",
  () =>
    Effect.gen(function* () {
      const s = yield* started;
      s.expectNone()
        .check(({ model }) => assert(model.trace).toEqual(TraceData.Loading()))
        .send(settled(Result.succeed(demoTrace)))
        .check(({ model }) => assert(model.trace).toEqual(TraceData.Success({ data: demoTrace })));
    }),
);

it.effect("the integration of loadDemoTrace decodes the bundled demo file", () =>
  Effect.map(loadDemoTrace, (trace) => assert(trace).toEqual(demoTrace)),
);

// HOVER

it.effect("leaving a node with nothing hovered leaves nothing hovered", () =>
  Effect.gen(function* () {
    const s = yield* started;
    s.given(ordinary)
      .send(Message.LeftNode())
      .check(({ model }) => assert(model.maybeHovered).toEqual(Option.none()));
  }),
);

it.effect.prop("hovering a node then leaving it clears the hover", { node: Node }, ({ node }) =>
  Effect.gen(function* () {
    const s = yield* started;
    s.given(ordinary)
      .send(Message.HoveredNode({ node }))
      .check(({ model }) => assert(model.maybeHovered).toEqual(Option.some(node)))
      .send(Message.LeftNode())
      .check(({ model }) => assert(model.maybeHovered).toEqual(Option.none()));
  }),
);

// PRESENCE

it.effect("the presence connection opens, then closes and forgets the room", () =>
  Effect.gen(function* () {
    const you = ParticipantId.make("p1");
    const s = yield* started;
    s.given(ordinary)
      .check(({ model }) =>
        assert(model.presenceConnection).toEqual(PresenceConnection.Connecting()),
      )
      .send(Message.OpenedPresence())
      .check(({ model }) =>
        assert(model.presenceConnection).toEqual(PresenceConnection.Connected()),
      )
      .send(
        Message.ReceivedPresence({
          presence: {
            participants: [{ id: you, kind: "human", name: "Ada", reading: Option.none() }],
            you,
          },
        }),
      )
      .check(({ model }) => assert(model.maybeYou).toEqual(Option.some(you)))
      .send(Message.ClosedPresence())
      .check(({ model }) => {
        assert(model.presenceConnection).toEqual(PresenceConnection.Disconnected());
        assert(model.maybeYou).toEqual(Option.none());
        assert(model.participants).toEqual([]);
      });
  }),
);
