import { Presence, PresenceJson, PrdSectionId, ReadingJson } from "@cairn/contract";
import { assert, it } from "@effect/vitest";
import {
  Array,
  Effect,
  Fiber,
  MutableRef,
  Number,
  Option,
  Ref,
  Schema,
  Stream,
  String,
} from "effect";
import { TestClock } from "effect/testing";
import { modifyFields } from "foldkit/struct";

import { Message } from "../src/message.ts";
import { init } from "../src/init.ts";
import { Screen } from "../src/model.ts";
import { update } from "../src/update.ts";
import { decodePresenceFrame, readingFrames, readingOf } from "../src/subscription/presence.ts";
import { loaded } from "./fixtures.ts";

const encodePresence = Schema.encodeSync(PresenceJson);

it.prop(
  "a presence frame decodes to the presence it was encoded from",
  [Presence],
  ([presence]) => {
    assert.deepStrictEqual(
      Option.map(decodePresenceFrame(encodePresence(presence)), encodePresence),
      Option.some(encodePresence(presence)),
    );
  },
);

it.prop(
  "a frame cut short, or text that is not a presence, is dropped",
  [Presence, Schema.Int, Schema.String],
  ([presence, cut, text]) => {
    const frame = encodePresence(presence);
    assert.isTrue(
      Option.isNone(
        decodePresenceFrame(String.slice(0, Number.remainder(cut, frame.length))(frame)),
      ),
    );
    assert.isTrue(Option.isNone(decodePresenceFrame(`[${text}`)));
  },
);

it("a frame that is not text, such as a binary frame, is dropped", () => {
  assert.isTrue(Option.isNone(decodePresenceFrame(new ArrayBuffer(4))));
  assert.isTrue(Option.isNone(decodePresenceFrame(null)));
});

const encodeReading = Schema.encodeSync(ReadingJson);

const prd = (id: string) => PrdSectionId.make(id);

it("the window reads the section at the top, then the pinned one, and nothing before a trace is loaded", () => {
  assert.deepStrictEqual(readingOf(init().model), Option.none());
  const reader = modifyFields(loaded, { screen: () => Screen.Reader() });
  const { model: atTop } = update(reader, Message.ScrolledPrd({ id: prd("prd.goal") }));
  assert.deepStrictEqual(readingOf(atTop), Option.some(prd("prd.goal")));
  const { model: pinned } = update(atTop, Message.ClickedStatusLine({ id: prd("prd.viewer") }));
  assert.deepStrictEqual(readingOf(pinned), Option.some(prd("prd.viewer")));
  // Scrolling on does not move a pinned section.
  const { model: scrolled } = update(pinned, Message.ScrolledPrd({ id: prd("prd.later") }));
  assert.deepStrictEqual(readingOf(scrolled), Option.some(prd("prd.viewer")));
});

it.effect(
  "the current section is sent once the socket is open and each time it changes, and not when it stays",
  () =>
    Effect.gen(function* () {
      const isOpen = MutableRef.make(false);
      const section = MutableRef.make(Option.none<PrdSectionId>());
      const sent = yield* Ref.make<ReadonlyArray<string>>([]);
      const fiber = yield* readingFrames(
        () => MutableRef.get(isOpen),
        () => MutableRef.get(section),
      ).pipe(
        Stream.runForEach((frame) => Ref.update(sent, Array.append(frame))),
        Effect.forkChild,
      );
      const tick = TestClock.adjust("100 millis");
      const framesAre = (wanted: ReadonlyArray<string>) =>
        Effect.map(Ref.get(sent), (frames) => assert.deepStrictEqual(frames, wanted));
      const goal = encodeReading({ reading: prd("prd.goal") });
      const viewer = encodeReading({ reading: prd("prd.viewer") });

      // Nothing to send while the socket is connecting, or while no section is known.
      yield* tick;
      MutableRef.set(section, Option.some(prd("prd.goal")));
      yield* tick;
      yield* framesAre([]);

      MutableRef.set(isOpen, true);
      yield* tick;
      yield* framesAre([goal]);

      yield* tick;
      yield* tick;
      yield* framesAre([goal]);

      MutableRef.set(section, Option.some(prd("prd.viewer")));
      yield* tick;
      yield* framesAre([goal, viewer]);
      yield* Fiber.interrupt(fiber);
    }),
);
