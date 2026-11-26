import {
  Config as CairnConfig,
  JudgmentTarget,
  Judgments,
  Manifest,
  Sha256Hex,
} from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  FileSystem,
  Effect,
  HashMap,
  Layer,
  Match,
  Option,
  Path,
  Predicate,
  Record,
  Ref,
  Schema,
  String,
  Struct,
} from "effect";
import { DecisionModel } from "effect/ai";
import type { Decision } from "effect/ai";
import { TestConsole } from "effect/testing";

import { formatJudgment, JudgeFlagged, judgePlan } from "../src/commands/judge.ts";
import { Judge } from "../src/judge.ts";
import { MainCheckout } from "../src/main-checkout.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJudgments = Schema.decodeUnknownSync(Schema.fromJsonString(Judgments));
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));

const PRD = "# Product {#prd.product}\n\n## Store {#prd.store}\n";
const SPEC = "# Spec {#spec.spec}\n\n## Store {#spec.store}\n\n- Implements: `prd.store`\n";

const manifestOf = (model: string) =>
  encodeJson({
    baseBranch: "main",
    feature: "product",
    tasks: [
      {
        branch: "cairn-mvp/01-store",
        commits: [],
        dependsOn: [],
        files: ["src/store.ts"],
        humanGate: { reasons: [], required: false },
        id: "t1",
        model,
        parent: null,
        prdSections: ["prd.store"],
        reasoning: "high",
        sessions: [],
        specSections: ["spec.store"],
        status: "pending",
        title: "Add the store",
        worktree: null,
      },
    ],
    version: 1,
  });

const defaults = Schema.decodeSync(CairnConfig)({});
const MODELS = Record.keys(defaults.judge.models);
const FIRST_MODEL = Option.getOrElse(Array.head(MODELS), () => "sonnet");

/** How the scripted model answers: a probability for each probability question. */
/** A rating of size is right and a reasoning level high, so the manifest's high is not flagged. */
const PREFERRED = ["right", "high"];

/** The label the scripted model picks among `labels`, as a rating of it. */
const pick = (labels: ReadonlyArray<string>) => {
  const chosen = Option.getOrElse(
    Array.findFirst(labels, (label) => Array.contains(PREFERRED, label)),
    () => Option.getOrElse(Array.head(labels), () => ""),
  );
  return {
    chosen,
    probabilities: Record.fromEntries(
      Array.map(labels, (label) => [label, label === chosen ? 1 : 0] as const),
    ),
    rating: Option.getOrElse(
      Array.findFirstIndex(labels, (label) => label === chosen),
      () => 0,
    ),
  };
};

const answerFor = (
  decision: Exclude<Decision.Any, Decision.Locate>,
  probability: number,
): DecisionModel.ProviderAnswer =>
  Match.value(decision).pipe(
    Match.tag("Probability", (): DecisionModel.ProviderAnswer => ({
      _tag: "Probability",
      probability,
    })),
    Match.tag("Rate", ({ criteria }): DecisionModel.ProviderAnswer => {
      const { probabilities, rating } = pick(Array.map(criteria, Struct.get("label")));
      return { _tag: "Rate", confidence: 0.9, probabilities, rating };
    }),
    Match.tag("Classify", ({ criteria }): DecisionModel.ProviderAnswer => {
      const { chosen, probabilities } = pick(Record.keys(criteria));
      return { _tag: "Classify", confidence: 0.9, label: chosen, probabilities };
    }),
    Match.exhaustive,
  );

/** A judge over a decision model that counts its calls and answers every probability `probability`. */
const judging = (calls: Ref.Ref<number>, probability: number) =>
  Judge.layerWith(defaults).pipe(
    Layer.provide(
      Layer.effect(
        DecisionModel.DecisionModel,
        DecisionModel.make({
          decide: (options) =>
            Ref.update(calls, (n) => n + 1).pipe(
              Effect.as({
                answers: Record.map(options.decisions, (decision) =>
                  answerFor(decision, probability),
                ),
                usage: { inputTokens: 1, outputTokens: 1 },
              }),
            ),
        }),
      ),
    ),
  );

/** The files of `.cairn/` after `run` in a fresh main checkout holding `files`. */
const inCheckout = <A, E, R>(files: Record<string, string>, run: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, ".cairn"), { recursive: true });
      yield* Effect.forEach(Record.toEntries(files), ([name, content]) =>
        fs.writeFileString(path.join(root, ".cairn", name), content),
      );
      const result = yield* run.pipe(Effect.provide(MainCheckout.fixed(root)));
      const names = yield* fs.readDirectory(path.join(root, ".cairn"));
      const entries = yield* Effect.forEach(names, (name) =>
        fs
          .readFileString(path.join(root, ".cairn", name))
          .pipe(Effect.map((text) => [name, text] as const)),
      );
      const after = Record.fromEntries(entries);
      return { after, result };
    }),
  ).pipe(Effect.provide(NodeServices.layer));

/** A file of `after`, empty when the run left none. */
const textOf = (after: Record<string, string>, name: string) =>
  Option.getOrElse(Record.get(after, name), () => "");

const both = { fresh: false, strict: false };

it.effect("writes judgments.json and prints a line for each flag, none for a pass", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const { after } = yield* inCheckout(
      { "manifest.json": manifestOf(FIRST_MODEL), "prd.md": PRD, "spec.md": SPEC },
      judgePlan(both).pipe(Effect.provide(judging(calls, 0.1))),
    );
    const written = decodeJudgments(textOf(after, "judgments.json"));
    expect(written.model).toBe(defaults.judge.model);
    expect(Array.length(written.judgments)).toBeGreaterThan(0);
    const printed = yield* TestConsole.logLines;
    const reported = Array.filter(written.judgments, ({ verdict }) => verdict !== "pass");
    expect(Array.length(printed)).toBe(Array.length(reported));
    expect(printed).toContain(
      ".cairn/spec.md:3 judge:buildable flag probability 0.1 is below flag 0.5",
    );
    expect(printed).toContain(
      ".cairn/manifest.json judge:ordered flag probability 0.1 is below flag 0.5",
    );
  }),
);

it.effect("a pass is written but not printed", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const { after } = yield* inCheckout(
      { "manifest.json": manifestOf(FIRST_MODEL), "prd.md": PRD, "spec.md": SPEC },
      judgePlan(both).pipe(Effect.provide(judging(calls, 1))),
    );
    const written = decodeJudgments(textOf(after, "judgments.json"));
    const logged = yield* TestConsole.logLines;
    const printed = Array.filter(logged, Predicate.isString);
    const quiet = Array.filter(written.judgments, ({ verdict }) => verdict === "pass");
    expect(Array.length(quiet)).toBeGreaterThan(0);
    expect(Array.every(printed, (line) => !String.includes(" pass ")(line))).toBe(true);
  }),
);

it.effect("asks again only with --fresh", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const files = {
      "manifest.json": manifestOf(FIRST_MODEL),
      "prd.md": PRD,
      "spec.md": SPEC,
    };
    yield* inCheckout(
      files,
      Effect.gen(function* () {
        yield* judgePlan(both);
        const first = yield* Ref.get(calls);
        yield* judgePlan(both);
        const again = yield* Ref.get(calls);
        yield* judgePlan({ fresh: true, strict: false });
        const fresh = yield* Ref.get(calls);
        expect(again).toBe(first);
        expect(fresh).toBe(first * 2);
      }).pipe(Effect.provide(judging(calls, 0.1))),
    );
  }),
);

it.effect(
  "--strict fails on a flag after writing judgments.json; without it the run succeeds",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const files = {
        "manifest.json": manifestOf(FIRST_MODEL),
        "prd.md": PRD,
        "spec.md": SPEC,
      };
      const strict = yield* inCheckout(
        files,
        Effect.flip(judgePlan({ fresh: false, strict: true })).pipe(
          Effect.provide(judging(calls, 0.1)),
        ),
      );
      expect(Schema.is(JudgeFlagged)(strict.result)).toBe(true);
      expect(
        Array.length(decodeJudgments(textOf(strict.after, "judgments.json")).judgments),
      ).toBeGreaterThan(0);

      const passing = yield* inCheckout(
        files,
        judgePlan({ fresh: false, strict: true }).pipe(Effect.provide(judging(calls, 1))),
      );
      expect(Array.every(passing.result.judgments, ({ verdict }) => verdict !== "flag")).toBe(true);
    }),
);

it.effect(
  "a confident model answer that differs from the manifest is a flag, and one that matches passes",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const chosen = FIRST_MODEL;
      const other = Option.getOrElse(
        Array.findFirst(MODELS, (name) => name !== chosen),
        () => "other",
      );
      const verdictOfModel = (manifestModel: string) =>
        inCheckout(
          { "manifest.json": manifestOf(manifestModel), "prd.md": PRD, "spec.md": SPEC },
          judgePlan(both).pipe(Effect.provide(judging(calls, 1))),
        ).pipe(
          Effect.map(({ result }) =>
            Array.findFirst(
              result.judgments,
              ({ question, target }) => question === "model" && target.kind === "task",
            ).pipe(Option.map(({ verdict }) => verdict)),
          ),
        );
      const same = yield* verdictOfModel(chosen);
      const differs = yield* verdictOfModel(other);
      expect(same).toEqual(Option.some("pass"));
      expect(differs).toEqual(Option.some("flag"));
    }),
);

it.effect("a kept judgment follows changed thresholds without asking again", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const files = {
      "manifest.json": manifestOf(FIRST_MODEL),
      "prd.md": PRD,
      "spec.md": SPEC,
    };
    const { result } = yield* inCheckout(
      files,
      Effect.gen(function* () {
        yield* judgePlan(both);
        const asked = yield* Ref.get(calls);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* (yield* MainCheckout).root;
        yield* fs.writeFileString(
          path.join(root, ".cairn", "config.json"),
          encodeJson({ judge: { flag: 0.94, pass: 0.99 } }),
        );
        const again = yield* judgePlan(both);
        const after = yield* Ref.get(calls);
        return { again, asked, after };
      }).pipe(Effect.provide(judging(calls, 0.9))),
    );
    expect(result.after).toBe(result.asked);
    expect(Array.some(result.again.judgments, ({ verdict }) => verdict === "flag")).toBe(true);
  }),
);

it.effect("changes no file but judgments.json", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const files = {
      "manifest.json": manifestOf(FIRST_MODEL),
      "prd.md": PRD,
      "spec.md": SPEC,
    };
    const { after } = yield* inCheckout(
      files,
      judgePlan(both).pipe(Effect.provide(judging(calls, 0.1))),
    );
    expect(textOf(after, "manifest.json")).toBe(files["manifest.json"]);
    expect(textOf(after, "spec.md")).toBe(files["spec.md"]);
    expect(textOf(after, "prd.md")).toBe(files["prd.md"]);
  }),
);

it("prints file:line judge:question verdict message, pointing a task at its first spec section", () => {
  const manifest = decodeManifest(manifestOf("sonnet"));
  const lines = HashMap.make(["spec.store", 7] as const);
  const base = {
    action: "none",
    answer: { probability: 0.1 },
    at: Schema.decodeSync(Schema.DateTimeUtcFromString)("2026-01-01T00:00:00.000Z"),
    inputHash: Sha256Hex.make(String.repeat(64)("0")),
    message: "probability 0.1 is below flag 0.4",
    round: 1,
    verdict: "flag",
  } as const;
  const decodeTarget = Schema.decodeUnknownSync(JudgmentTarget);
  expect(
    formatJudgment(
      { ...base, question: "matches", target: decodeTarget({ id: "t1", kind: "task" }) },
      manifest,
      lines,
    ),
  ).toBe(".cairn/spec.md:7 judge:matches flag probability 0.1 is below flag 0.4");
  expect(
    formatJudgment(
      { ...base, question: "complete", target: decodeTarget({ kind: "stack" }) },
      manifest,
      lines,
    ),
  ).toBe(".cairn/manifest.json judge:complete flag probability 0.1 is below flag 0.4");
});
