import { it } from "@effect/vitest";
import { Option } from "effect";
import { expect } from "vitest";

import { highlight, languageOf, styleOf } from "../src/code.ts";

it("a token's colour and font style become CSS", () => {
  expect(styleOf({ color: "#112233", content: "x", fontStyle: 0, offset: 0 })).toEqual({
    color: "#112233",
  });
  expect(styleOf({ color: "#112233", content: "x", fontStyle: 1 | 2, offset: 0 })).toEqual({
    color: "#112233",
    "font-style": "italic",
    "font-weight": "bold",
  });
  expect(styleOf({ content: "x", fontStyle: 4 | 8, offset: 0 })).toEqual({
    "text-decoration": "underline line-through",
  });
  expect(styleOf({ content: "x", offset: 0 })).toEqual({});
});

it("a fence's language is its first word", () => {
  expect(languageOf('ts title="a.ts"')).toEqual(Option.some("ts"));
  expect(languageOf("  json")).toEqual(Option.some("json"));
  expect(languageOf("")).toEqual(Option.none());
  expect(languageOf(null)).toEqual(Option.none());
  expect(languageOf(undefined)).toEqual(Option.none());
});

it("a language with a lexer highlights, and one without is left plain", () => {
  expect(Option.isSome(highlight("const x = 1;", "ts"))).toBe(true);
  expect(Option.isSome(highlight("flowchart LR", "mermaid"))).toBe(true);
  expect(Option.isNone(highlight("const x = 1;", "not-a-language"))).toBe(true);
});

it("highlighting yields a line of tokens per line of code", () => {
  const lines = Option.getOrThrow(highlight("const a = 1;\n\nconst b = 2;", "ts"));
  expect(lines.length).toBe(3);
  expect(lines[1]).toEqual([]);
});
