import { expect, it } from "@effect/vitest";
import { Array, Exit, Schema, Struct, pipe } from "effect";

import { Config, ConfigJson, Reasoning, defaultConfig } from "../src/index.ts";

const encode = Schema.encodeSync(Config);
const decode = Schema.decodeUnknownSync(Config);
const decodeExit = Schema.decodeUnknownExit(Config);
const refused = (input: unknown) => Exit.isFailure(decodeExit(input));
const refusal = (input: unknown) => String(decodeExit(input));

/** A config's encoding with its judge thresholds replaced by `patch`. */
const withJudge = (
  config: Config,
  patch: Partial<Record<"pass" | "flag" | "minProbability", number>>,
) => ({
  ...encode(config),
  judge: { ...config.judge, ...patch },
});

/** A config document whose planner is `planner`. */
const withPlanner = (planner: Record<string, unknown>) => ({ planner, version: 1 });

/** A number above 1: its negation is below 0. */
const above = Schema.Finite.check(Schema.isGreaterThan(1));

/** A string that is not one of `values`. */
const notIn = (values: ReadonlyArray<string>) =>
  Schema.NonEmptyString.check(
    Schema.makeFilter<string>((value) =>
      Array.contains(values, value) ? "the value is one of the listed values" : undefined,
    ),
  );

it('{"version":1} decodes to the full defaults', () => {
  expect(decode({ version: 1 })).toEqual(defaultConfig);
  expect(defaultConfig.humanPaths).toContain("**/migrations/**");
  expect(defaultConfig.humanPaths).toContain("**/migrate/**");
  expect(defaultConfig.humanPaths).not.toContain("*.sql");
  expect(defaultConfig.redact.deny).toEqual([]);
  expect(defaultConfig.planner).toEqual({ cli: "claude", provider: "anthropic", source: "cli" });
  expect(defaultConfig.planner.model).toBeUndefined();
  expect(defaultConfig.judge).toMatchObject({
    flag: 0.3,
    maxRounds: 2,
    minProbability: 0.5,
    model: "jev-1.14.0",
    pass: 0.7,
  });
});

it("the conflicts block defaults to the generated and additive patterns, 0.5, 500 and 3", () => {
  expect(defaultConfig.conflicts).toStrictEqual({
    additive: ["**/index.ts"],
    generated: ["pnpm-lock.yaml", "**/demo-trace.json", "packages/contract/schema/**"],
    high: 0.5,
    history: 500,
    hotspot: 3,
  });
  expect(decode({ conflicts: { high: 0.7 }, version: 1 }).conflicts).toStrictEqual({
    ...defaultConfig.conflicts,
    high: 0.7,
  });
});

/** Whether a config whose \`conflicts\` block is \`conflicts\` is refused. */
const refusedWith = (conflicts: Record<string, unknown>) => refused({ conflicts, version: 1 });

it("a conflicts block whose threshold is outside [0, 1], or whose counts are too small, is refused", () => {
  expect(refusedWith({ high: 1.1 })).toBe(true);
  expect(refusedWith({ high: -0.1 })).toBe(true);
  expect(refusedWith({ history: 0 })).toBe(true);
  expect(refusedWith({ history: 1.5 })).toBe(true);
  expect(refusedWith({ hotspot: 1 })).toBe(true);
  expect(refusedWith({ history: 1, hotspot: 2, high: 1 })).toBe(false);
});

it("the default categories are the PRD's eight, each with a description", () => {
  expect(Array.map(defaultConfig.categories, ({ name }) => name)).toEqual([
    "mechanical",
    "feature",
    "ui",
    "test",
    "schema",
    "refactor",
    "bugfix",
    "docs",
  ]);
  expect(Array.every(defaultConfig.categories, ({ description }) => description !== "")).toBe(true);
});

it("a repo's own categories replace the defaults, and a name that is not a slug is refused", () => {
  const own = [{ description: "Infrastructure", name: "infra" }];
  expect(decode({ categories: own, version: 1 }).categories).toEqual(own);
  expect(refused({ categories: [{ description: "x", name: "Not A Slug" }], version: 1 })).toBe(
    true,
  );
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
  expect(refused(withJudge(config, { minProbability: high }))).toBe(true);
});

it("the refusal names the rule that failed", () => {
  const exit = decodeExit({ version: 1, judge: { flag: 0.9, pass: 0.5 } });
  expect(String(exit)).toContain("judge.pass must be greater than judge.flag");
});

it.prop(
  "given judge values are kept and the rest default",
  [Schema.Finite.check(Schema.isBetween({ exclusiveMinimum: true, maximum: 1, minimum: 0.3 }))],
  ([pass]) => {
    const config = decode({ version: 1, judge: { pass } });
    expect(config.judge.pass).toBe(pass);
    expect(config.judge.flag).toBe(0.3);
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
    expect(config.planner.source).toBe("cli");
    expect(config.planner.cli).toBe("claude");
    expect(config.planner.provider).toBe("anthropic");
    expect(config.planner.baseUrl).toBeUndefined();
    expect(config.judge).toEqual(defaultConfig.judge);
  },
);

it.prop(
  "an api planner with no planner.model is refused, and the refusal names the field",
  [Config],
  ([config]) => {
    const planner = pipe(
      { ...encode(config).planner, source: "api" as const },
      Struct.omit(["model"]),
    );
    expect(refused({ ...encode(config), planner })).toBe(true);
    expect(refusal({ ...encode(config), planner })).toContain("planner.model");
  },
);

it.prop("an api planner with a model is accepted", [Schema.NonEmptyString], ([model]) => {
  expect(refused(withPlanner({ model, source: "api" }))).toBe(false);
});

it.prop(
  "an openai-compatible api planner with no planner.baseUrl is refused, and the refusal names the field",
  [Schema.NonEmptyString],
  ([model]) => {
    const input = withPlanner({ model, provider: "openai-compatible", source: "api" });
    expect(refused(input)).toBe(true);
    expect(refusal(input)).toContain("planner.baseUrl");
  },
);

it.prop(
  "an openai-compatible api planner with a model and a baseUrl is accepted",
  [Schema.NonEmptyString, Schema.NonEmptyString],
  ([model, baseUrl]) => {
    const input = withPlanner({ baseUrl, model, provider: "openai-compatible", source: "api" });
    expect(refused(input)).toBe(false);
  },
);

it.prop(
  "an api planner with planner.gatewayTokenEnv and no planner.baseUrl is refused, and the refusal names the field",
  [Schema.NonEmptyString, Schema.NonEmptyString],
  ([model, gatewayTokenEnv]) => {
    const input = withPlanner({ gatewayTokenEnv, model, source: "api" });
    expect(refused(input)).toBe(true);
    expect(refusal(input)).toContain("planner.baseUrl");
  },
);

it.prop(
  "an api planner with planner.gatewayTokenEnv and a baseUrl is accepted, and keeps the variable's name",
  [Schema.NonEmptyString, Schema.NonEmptyString, Schema.NonEmptyString],
  ([model, baseUrl, gatewayTokenEnv]) => {
    const input = withPlanner({ baseUrl, gatewayTokenEnv, model, source: "api" });
    expect(refused(input)).toBe(false);
    expect(decode(input).planner.gatewayTokenEnv).toBe(gatewayTokenEnv);
  },
);

it.prop(
  "judge.gatewayTokenEnv with no judge.baseUrl is refused, and the refusal names both fields",
  [Schema.NonEmptyString],
  ([gatewayTokenEnv]) => {
    const input = { judge: { gatewayTokenEnv }, version: 1 };
    expect(refused(input)).toBe(true);
    expect(refusal(input)).toContain("judge.baseUrl");
    expect(refusal(input)).toContain("judge.gatewayTokenEnv");
  },
);

it.prop(
  "judge.gatewayTokenEnv with a judge.baseUrl is accepted, and keeps the variable's name",
  [Schema.NonEmptyString, Schema.NonEmptyString],
  ([baseUrl, gatewayTokenEnv]) => {
    const input = { judge: { baseUrl, gatewayTokenEnv }, version: 1 };
    expect(refused(input)).toBe(false);
    expect(decode(input).judge.gatewayTokenEnv).toBe(gatewayTokenEnv);
  },
);

it("the default judge has no gatewayTokenEnv", () => {
  expect(defaultConfig.judge.gatewayTokenEnv).toBeUndefined();
});

it("a cli planner ignores planner.gatewayTokenEnv, and the default has none", () => {
  expect(refused(withPlanner({ gatewayTokenEnv: "TOKEN", source: "cli" }))).toBe(false);
  expect(defaultConfig.planner.gatewayTokenEnv).toBeUndefined();
});

it("the baseUrl rule applies only to an api planner: a cli planner ignores the provider", () => {
  expect(refused(withPlanner({ provider: "openai-compatible" }))).toBe(false);
  expect(refused(withPlanner({ provider: "openai-compatible", source: "cli" }))).toBe(false);
});

it.prop(
  "planner.effort takes a reasoning level for the spec draft, for the tasks draft, or for both",
  [Reasoning, Reasoning],
  ([spec, tasks]) => {
    expect(decode(withPlanner({ effort: { spec, tasks } })).planner.effort).toEqual({
      spec,
      tasks,
    });
    expect(decode(withPlanner({ effort: { tasks } })).planner.effort).toEqual({ tasks });
    expect(decode(withPlanner({ effort: {} })).planner.effort).toEqual({});
  },
);

it.prop(
  "an effort that is not a reasoning level is refused, and the default sets none",
  [notIn(Reasoning.literals)],
  ([level]) => {
    expect(refused(withPlanner({ effort: { spec: level } }))).toBe(true);
    expect(refused(withPlanner({ effort: { tasks: level } }))).toBe(true);
    expect(defaultConfig.planner.effort).toBeUndefined();
  },
);

it.prop("a source outside cli and api is refused", [notIn(["cli", "api"])], ([source]) => {
  expect(refused(withPlanner({ model: "m", source }))).toBe(true);
});

it.prop("a cli outside claude and codex is refused", [notIn(["claude", "codex"])], ([cli]) => {
  expect(refused(withPlanner({ cli }))).toBe(true);
});

it.prop(
  "a provider outside the four named ones is refused",
  [notIn(["anthropic", "openai", "openrouter", "openai-compatible"])],
  ([provider]) => {
    expect(refused(withPlanner({ provider }))).toBe(true);
  },
);
