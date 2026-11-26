import { SectionId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Number, Option, Result, Schema, String } from "effect";

import { diffSelectionOf, itemIdOf, linesOfRange, parsePatch } from "../src/diff.ts";
import { QUOTE_LIMIT, passageButtonOf } from "../src/links.ts";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { indexOf } from "../src/search.ts";
import { messageOf, quoteOf, selectionOf, sharedPassageOf } from "../src/subscription/selection.ts";
import commitPatch from "./fixtures/commit.patch?raw";

const Positive = Schema.Int.check(Schema.isBetween({ maximum: 100_000, minimum: 1 }));
const Side = Schema.Literals(["additions", "deletions"]);

// THE QUOTE

const isQuoteText = Schema.is(Schema.String.check(Schema.isPattern(/^(?:\S+(?: \S+)*)?$/u)));

it.prop(
  "a quote has single spaces between its words and none at either end",
  [Schema.String],
  ([text]) => {
    const quote = quoteOf(text);
    expect(isQuoteText(quote)).toBe(true);
    // Its words are the text's words, in order.
    expect(quote).toBe(
      Array.join(Array.filter(String.split(text, /\s+/u), String.isNonEmpty), " "),
    );
    expect(quoteOf(quote)).toBe(quote);
  },
);

it("a quote collapses every kind of whitespace, line breaks and no-break spaces included", () => {
  expect(quoteOf("  one\n\ttwo \xa0 three\r\n")).toBe("one two three");
  expect(quoteOf(" \n ")).toBe("");
});

// THE PASSAGE THAT HOLDS BOTH ENDS

it.prop(
  "the passage that holds both ends is the one that holds each, and none when they differ or one is outside",
  [Schema.Option(Schema.Int), Schema.Option(Schema.Int)],
  ([start, end]) => {
    expect(sharedPassageOf(start, end)).toEqual(
      Option.filter(start, (passage) => Option.contains(end, passage)),
    );
    expect(Option.isSome(sharedPassageOf(start, end))).toBe(
      Option.isSome(start) &&
        Option.isSome(end) &&
        Option.getOrThrow(start) === Option.getOrThrow(end),
    );
  },
);

// THE SELECTION

it("a selection in a section's passage is that section and the quote of its text", () => {
  expect(selectionOf(Option.some("prd.viewer"), "  Some \n words  ")).toEqual(
    Option.some({ quote: "Some words", section: SectionId.make("prd.viewer") }),
  );
});

it("a selection in no passage, in an element with no section, or with only whitespace is none", () => {
  expect(selectionOf(Option.none(), "words")).toEqual(Option.none());
  expect(selectionOf(Option.some(""), "words")).toEqual(Option.none());
  expect(selectionOf(Option.some("prd.viewer"), " \n\t ")).toEqual(Option.none());
});

it("a selection that changed is sent as the passage it selects, and one that left as its end", () => {
  const section = SectionId.make("prd.viewer");
  expect(messageOf(Option.some({ quote: "words", section }))).toEqual(
    Message.SelectedPassage({ quote: "words", section }),
  );
  expect(messageOf(Option.none())).toEqual(Message.ClearedPassageSelection());
});

// THE BUTTON

const section = SectionId.make("prd.viewer");
const heldQuote = Option.getOrThrow(
  Option.flatMap(
    Array.findFirst(indexOf(demoTrace).content, (entry) => entry.node.id === section),
    (entry) =>
      Option.map(
        Array.findFirst(entry.fields, (field) => field.kind === "prose"),
        (field) => Array.join(Array.take(String.split(quoteOf(field.text), " "), 4), " "),
      ),
  ),
);

it.prop(
  "a quote over the limit disables the button, whatever the prose holds",
  [Schema.Int.check(Schema.isBetween({ maximum: 2 * QUOTE_LIMIT, minimum: QUOTE_LIMIT + 1 }))],
  ([length]) => {
    expect(
      passageButtonOf(demoTrace, Option.some({ quote: String.repeat(length)("a"), section })),
    ).toEqual(Option.some({ isOverLimit: true, section }));
  },
);

it("a quote the section's prose holds enables the button, and one it does not hold has none", () => {
  expect(passageButtonOf(demoTrace, Option.some({ quote: heldQuote, section }))).toEqual(
    Option.some({ isOverLimit: false, section }),
  );
  // The text of a code block or a diagram is shown but is not prose, so the resolver cannot find it.
  expect(
    passageButtonOf(demoTrace, Option.some({ quote: `${heldQuote} nobody wrote this`, section })),
  ).toEqual(Option.none());
  // The same words in another section are not in this one.
  expect(
    passageButtonOf(
      demoTrace,
      Option.some({ quote: heldQuote, section: SectionId.make("prd.goal") }),
    ),
  ).toEqual(Option.none());
});

it("a selection a link cannot quote has no button", () => {
  expect(passageButtonOf(demoTrace, Option.some({ quote: "..", section }))).toEqual(Option.none());
  expect(passageButtonOf(demoTrace, Option.none())).toEqual(Option.none());
});

// THE DIFF'S LINES

it.prop(
  "a range of lines is ordered, on the side it started on",
  [Positive, Positive, Side],
  ([from, to, side]) => {
    const lines = Option.getOrThrow(linesOfRange({ end: to, side, start: from }));
    expect(lines).toEqual({
      end: Number.max(from, to),
      kind: "lines",
      side: side === "additions" ? "new" : "old",
      start: Number.min(from, to),
    });
  },
);

it("a range with no side is on the new side", () => {
  expect(linesOfRange({ end: 9, start: 4 })).toEqual(
    Option.some({ end: 9, kind: "lines", side: "new", start: 4 }),
  );
});

it("a range from one side to the other links its first line", () => {
  expect(linesOfRange({ end: 9, endSide: "additions", side: "deletions", start: 4 })).toEqual(
    Option.some({ end: 4, kind: "lines", side: "old", start: 4 }),
  );
});

it("line numbers below one are not lines", () => {
  expect(linesOfRange({ end: 3, start: 0 })).toEqual(Option.none());
});

// THE FILE A SELECTION WAS MADE IN

const { files } = Result.getOrThrow(parsePatch(commitPatch));
const [first, second] = [
  Option.getOrThrow(Array.get(files, 0)).name,
  Option.getOrThrow(Array.get(files, 1)).name,
];

it("a selection is in the file whose item it was made in, with the lines it selected there", () => {
  expect(
    diffSelectionOf(files, itemIdOf(second), Option.some({ end: 6, side: "deletions", start: 5 })),
  ).toEqual(Option.some({ lines: { end: 6, kind: "lines", side: "old", start: 5 }, path: second }));
  expect(diffSelectionOf(files, itemIdOf(first), Option.some({ end: 2, start: 2 }))).toEqual(
    Option.some({ lines: { end: 2, kind: "lines", side: "new", start: 2 }, path: first }),
  );
});

it("a cleared selection, or one in an item the patch does not hold, selects nothing", () => {
  expect(diffSelectionOf(files, itemIdOf(first), Option.none())).toEqual(Option.none());
  expect(
    diffSelectionOf(files, itemIdOf("not/in/the/patch.ts"), Option.some({ end: 2, start: 2 })),
  ).toEqual(Option.none());
});
