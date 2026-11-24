import { readFileSync } from "node:fs";

import { it } from "@effect/vitest";
import { Array, Number, Option, Order, Record, String, pipe } from "effect";
import { expect } from "vitest";

const stylesheet = (name: string) =>
  readFileSync(new URL(`../src/ui/${name}`, import.meta.url), "utf8");

/** The stylesheets that use tokens. t100 adds "components.css" here. */
const usingTokens = ["base.css"];

const tokensCss = stylesheet("tokens.css");

const tokens: Record<string, string> = pipe(
  Array.fromIterable(String.matchAll(/(--[\w-]+):\s*([^;]+);/gu)(tokensCss)),
  Array.map((match) =>
    Option.all([Array.get(match, 1), Array.get(match, 2)]).pipe(
      Option.map(([name, value]) => [name, String.trim(value)] as const),
    ),
  ),
  Array.getSomes,
  Record.fromEntries,
);

const isShapeOrTypeOrMotion = String.match(/^--(line|r-|lift|mono|prose|t-|ease|d-)/u);

const colourTokens = Record.filter(tokens, (_, name) => Option.isNone(isShapeOrTypeOrMotion(name)));

const hex = "#[0-9a-f]{6}";
const lightDark = new RegExp(`^light-dark\\((${hex}), (${hex})\\)$`, "u");
const colorMix = /^color-mix\(in srgb, var\((--[\w-]+)\) \d+%, transparent\)$/u;

type Side = "light" | "dark";

/** A token's hex colour in one palette. */
const colourOf = (side: Side, name: string): string =>
  Option.getOrThrow(
    pipe(
      Record.get(tokens, name),
      Option.flatMap(String.match(lightDark)),
      Option.flatMap(Array.get(side === "light" ? 1 : 2)),
    ),
  );

const channel = (value: string, start: number): number => {
  const byte = Option.getOrThrow(Number.parse(`0x${pipe(value, String.slice(start, start + 2))}`));
  const unit = byte / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

const luminance = (colour: string): number =>
  0.2126 * channel(colour, 1) + 0.7152 * channel(colour, 3) + 0.0722 * channel(colour, 5);

/** The WCAG contrast ratio of two hex colours. */
const contrast = (a: string, b: string): number => {
  const [high, low] = [
    Order.max(Order.Number)(luminance(a), luminance(b)),
    Order.min(Order.Number)(luminance(a), luminance(b)),
  ];
  return (high + 0.05) / (low + 0.05);
};

const models = ["--m-opus", "--m-sonnet", "--m-haiku", "--m-other"];
const inkFills = ["--bg", "--card", "--raised", "--green", "--prd", "--spec"];

const pairs: ReadonlyArray<readonly [text: string, fills: ReadonlyArray<string>]> = [
  ["--ink", Array.appendAll(inkFills, models)],
  ["--ink-soft", ["--bg", "--card"]],
  ["--muted", ["--bg", "--card"]],
  ["--blocked-ink", ["--bg", "--card"]],
];

it("every colour token is a light-dark() pair of hex colours or a color-mix() of tokens", () => {
  expect(Record.size(colourTokens)).toBeGreaterThanOrEqual(21);
  Array.forEach(Record.toEntries(colourTokens), ([name, value]) => {
    const isPair = Option.isSome(String.match(lightDark)(value));
    const mixed = pipe(
      String.match(colorMix)(value),
      Option.flatMap(Array.get(1)),
      Option.exists((other) => Record.has(tokens, other)),
    );
    expect(isPair || mixed, `${name}: ${value}`).toBe(true);
  });
});

it.each(["light", "dark"] as const)(
  "in the %s palette the text tokens read on their fills",
  (side) => {
    Array.forEach(pairs, ([text, fills]) =>
      Array.forEach(fills, (fill) => {
        const ratio = contrast(colourOf(side, text), colourOf(side, fill));
        expect(ratio, `${side}: ${text} on ${fill} is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }),
    );
  },
);

it.each(usingTokens)(
  "%s uses only tokens that tokens.css defines and no literal colour",
  (name) => {
    const css = stylesheet(name);
    const used = pipe(
      Array.fromIterable(String.matchAll(/var\((--[\w-]+)/gu)(css)),
      Array.map((match) => Array.get(match, 1)),
      Array.getSomes,
    );
    expect(Array.isReadonlyArrayNonEmpty(used)).toBe(true);
    expect(Array.filter(used, (token) => !Record.has(tokens, token))).toEqual([]);
    expect(Option.isNone(String.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/iu)(css))).toBe(true);
  },
);
