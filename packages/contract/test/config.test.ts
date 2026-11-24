import { expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";

import { Config, ConfigJson, defaultConfig } from "../src/index.ts";

const encode = Schema.encodeSync(Config);
const decode = Schema.decodeUnknownSync(Config);
const decodeExit = Schema.decodeUnknownExit(Config);
const refused = (input: unknown) => Exit.isFailure(decodeExit(input));

/** A config's encoding with its judge thresholds replaced by `patch`. */
const withJudge = (
  config: Config,
  patch: Partial<Record<"pass" | "flag" | "minConfidence", number>>,
) => ({
  ...encode(config),
  judge: { ...config.judge, ...patch },
});

/** A number above 1: its negation is below 0. */
const above = Schema.Finite.check(Schema.isGreaterThan(1));

it('{"version":1} decodes to the full defaults', () => {
  expect(decode({ version: 1 })).toEqual(defaultConfig);
  expect(defaultConfig.humanPaths).toContain("**/migrations/**");
  expect(defaultConfig.redact.deny).toEqual([]);
  expect(defaultConfig.planner.model).toBe("claude-opus-5-5");
  expect(defaultConfig.judge).toMatchObject({
    flag: 0.5,
    maxRounds: 2,
    minConfidence: 0.5,
    model: "jev-1.14.0",
    pass: 0.8,
  });
});

it("a missing file, read as {}, decodes to the same defaults", () => {
  expect(decode({})).toEqual(defaultConfig);
});

it("the default models table names haiku, sonnet and opus with their uses", () => {
  expect(defaultConfig.judge.models).toEqual({
    haiku: "Mechanical changes: a schema field, a rename, a command wired to existing code",
    opus: "Logic where a subtle bug costs a lot: derivation, ordering, redaction, concurrency",
    sonnet: "Most tasks: a feature or service with its tests across a few files",
  });
});

it.prop("a valid config round-trips through JSON", [Config], ([config]) => {
  // Compare the JSON text: JSON has no -0, so a generated -0 would fail toEqual for no real reason.
  const json = Schema.encodeSync(ConfigJson)(config);
  expect(Schema.encodeSync(ConfigJson)(Schema.decodeSync(ConfigJson)(json))).toBe(json);
});

it.prop("a pass threshold at or below the flag is refused", [Config], ([config]) => {
  const { flag } = config.judge;
  expect(refused(withJudge(config, { pass: flag }))).toBe(true);
  expect(refused(withJudge(config, { pass: flag * 0.5 }))).toBe(true);
});

it("a pass threshold above the flag is accepted", () => {
  expect(refused({ version: 1, judge: { flag: 0.4, pass: 0.6 } })).toBe(false);
});

it.prop("a threshold outside [0, 1] is refused", [Config, above], ([config, high]) => {
  expect(refused(withJudge(config, { pass: high }))).toBe(true);
  expect(refused(withJudge(config, { flag: -high }))).toBe(true);
  expect(refused(withJudge(config, { minConfidence: high }))).toBe(true);
});

it("the refusal names the rule that failed", () => {
  const exit = decodeExit({ version: 1, judge: { flag: 0.9, pass: 0.5 } });
  expect(String(exit)).toContain("judge.pass must be greater than judge.flag");
});

it.prop(
  "given judge values are kept and the rest default",
  [Schema.Finite.check(Schema.isBetween({ exclusiveMinimum: true, maximum: 1, minimum: 0.5 }))],
  ([pass]) => {
    const config = decode({ version: 1, judge: { pass } });
    expect(config.judge.pass).toBe(pass);
    expect(config.judge.flag).toBe(0.5);
    expect(config.judge.model).toBe("jev-1.14.0");
    expect(config.humanPaths).toEqual(defaultConfig.humanPaths);
  },
);

it.prop(
  "given planner values are kept and the rest default",
  [Schema.NonEmptyString],
  ([model]) => {
    const config = decode({ planner: { model }, version: 1 });
    expect(config.planner.model).toBe(model);
    expect(config.planner.baseUrl).toBeUndefined();
    expect(config.judge).toEqual(defaultConfig.judge);
  },
);
