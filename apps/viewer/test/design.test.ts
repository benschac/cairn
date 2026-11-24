import { readFileSync } from "node:fs";

import { it } from "@effect/vitest";
import { Array, Number, Option, Order, Record, String, pipe } from "effect";
import { expect } from "vitest";

const stylesheet = (name: string) =>
  readFileSync(new URL(`../src/ui/${name}`, import.meta.url), "utf8");

/** The stylesheets that use tokens. */
const usingTokens = ["base.css", "components.css"];

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

/** The stylesheet without its comments, which name attributes and tokens in prose. */
const components = pipe(stylesheet("components.css"), String.replaceAll(/\/\*[\s\S]*?\*\//gu, ""));

/** The classes of the spec's table of pieces; `prose` is in `base.css`. */
const pieces = [
  "topbar",
  "label",
  "dot",
  "tag",
  "gate",
  "btn",
  "seg",
  "chip",
  "row",
  "card",
  "card-head",
  "card-body",
  "card-tasks",
  "stack",
  "base-bar",
  "divider",
  "panel",
  "meter",
  "wire",
];

it.each(pieces)("components.css has a rule for the %s piece", (piece) => {
  const rule = new RegExp(`(?:^|[\\s,])\\.${piece}\\s*[,{]`, "u");
  expect(Option.isSome(String.match(rule)(components))).toBe(true);
});

// A token names each of these, so the stylesheet says the token.
const literals: ReadonlyArray<readonly [what: string, pattern: RegExp]> = [
  ["a 1.5px border width", /\b1\.5px/u],
  ["a timing", /\b(?:150|160|240)ms/u],
  ["an easing curve", /cubic-bezier/u],
  ["a font family", /font-family|ui-monospace|Charter/u],
  ["a font size", /font-size:\s*[\d.]+px/u],
  ["a radius", /border-radius:\s*(?:4|8|12)px/u],
  ["a shadow", /box-shadow:\s*0\s+[23]px/u],
];

it.each(literals)("components.css writes no %s", (_, pattern) => {
  expect(Option.isNone(String.match(pattern)(components))).toBe(true);
});

it("components.css selects state by attribute, never by a second class", () => {
  expect(Option.isNone(String.match(/\.[a-z][\w-]*\.[a-z]/u)(components))).toBe(true);
});

/** The property of each declaration in a block, such as the body of a `from` keyframe. */
const propertiesOf = (body: string): ReadonlyArray<string> =>
  pipe(
    String.split(body, ";"),
    Array.map((declaration) => String.trim(Array.headNonEmpty(String.split(declaration, ":")))),
    Array.filter(String.isNonEmpty),
  );

/** Each transition's property and the timing written after it. */
const transitions = pipe(
  Array.fromIterable(String.matchAll(/transition:\s*([^;]+);/gu)(components)),
  Array.flatMap((match) => Array.getSomes([Array.get(match, 1)])),
  Array.flatMap(String.split(",")),
  Array.map(String.trim),
  Array.map(String.match(/^(\S+)\s+(.+)$/u)),
  Array.getSomes,
  Array.map((match) => [Array.get(match, 1), Array.get(match, 2)] as const),
  Array.map(([property, timing]) => Option.all([property, timing])),
  Array.getSomes,
);

const fade = "var(--d-fade) ease-out";
const press = "var(--d-press) var(--ease)";

const timingOf: Record<string, string> = {
  "background-color": fade,
  "border-color": fade,
  color: fade,
  opacity: fade,
  transform: press,
};

it("components.css animates only opacity, transform and colours, on the spec's timings", () => {
  expect(Array.isReadonlyArrayNonEmpty(transitions)).toBe(true);
  Array.forEach(transitions, ([property, timing]) => {
    expect(Record.get(timingOf, property), `${property} ${timing}`).toEqual(Option.some(timing));
  });
});

it("the keyframes of components.css move only opacity and transform, over --d-move", () => {
  const frames = Array.fromIterable(String.matchAll(/\b(?:from|to)\s*\{([^}]*)\}/gu)(components));
  expect(Array.isReadonlyArrayNonEmpty(frames)).toBe(true);
  Array.forEach(frames, (frame) =>
    Array.forEach(propertiesOf(Option.getOrThrow(Array.get(frame, 1))), (property) =>
      expect(["opacity", "transform"]).toContain(property),
    ),
  );
  expect(
    Option.isSome(String.match(/animation:\s*[\w-]+ var\(--d-move\) var\(--ease\)/u)(components)),
  ).toBe(true);
});

it("a pressed btn moves down 2px and loses its shadow", () => {
  const pressed = pipe(
    String.match(/\.btn:active\s*\{([^}]*)\}/u)(components),
    Option.flatMap(Array.get(1)),
    Option.getOrThrow,
  );
  expect(pressed).toContain("transform: translateY(2px)");
  expect(pressed).toContain("box-shadow: none");
});
