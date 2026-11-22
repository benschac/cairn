import { Presence, PresenceJson } from "@cairn/contract";
import { assert, it } from "@effect/vitest";
import { Number, Option, Schema, String } from "effect";

import { decodePresenceFrame } from "../src/subscription/presence.ts";

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
