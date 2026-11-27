import { createHash } from "node:crypto";

import {
  Config as CairnConfig,
  Judgments,
  PrdSectionId,
  SpecSectionId,
  TaskId,
} from "@cairn/contract";
import type { JudgmentTarget } from "@cairn/contract";
import {
  PrdSectionJudgingInput,
  SectionJudgingInput,
  StackJudgingInput,
  TaskJudgingInput,
  verdictOf,
  yesNoOf,
} from "@cairn/core";
import type { JudgingInputs } from "@cairn/core";
import { expect, it } from "@effect/vitest";
import {
  Array,
  ConfigProvider,
  Context,
  DateTime,
  Duration,
  Effect,
  Equal,
  Fiber,
  Layer,
  Match,
  Number,
  Option,
  Order,
  Predicate,
  Record,
  Ref,
  Result,
  Schema,
  Struct,
} from "effect";
import { AiError, Decision, DecisionModel } from "effect/ai";
import { TestClock } from "effect/testing";

import { Judge, JudgeError, inputHashesOf } from "../src/judge.ts";

/**
 * Nothing here reads a key or touches the network. The decision model is `DecisionModel.make`
 * over a scripted `decide`, which answers every decision it is sent and records each request.
 */
class Calls extends Context.Service<
  Calls,
  {
    /** The requests the model was sent, in order. */
    readonly seen: Effect.Effect<ReadonlyArray<DecisionModel.ProviderOptions>>;
    /** The most requests that were in flight at once. */
    readonly most: Effect.Effect<number>;
  }
>()("@cairn/cli/test/judge/Calls") {}

interface Script {
  /** What the first calls fail with, in order; later calls answer. */
  readonly failures?: ReadonlyArray<AiError.AiError>;
  /** The probability of every probability decision, read from the encoded input; 0.9 by default. */
  readonly probability?: (state: Schema.Json) => number;
  /** Decisions the model refuses. */
  readonly refuse?: ReadonlyArray<string>;
  /** How long each call takes, on the test clock. */
  readonly takes?: Duration.Duration;
}

/** One label gets all the probability: the first, so answers are the same on every run. */
const oneHot = (labels: ReadonlyArray<string>) =>
  Record.fromEntries(Array.map(labels, (label, index) => [label, index === 0 ? 1 : 0] as const));

const answerFor = (
  name: string,
  decision: Exclude<Decision.Any, Decision.Locate>,
  refuse: ReadonlyArray<string>,
  probability: number,
): DecisionModel.ProviderAnswer =>
  Array.contains(refuse, name)
    ? { _tag: "Refusal" }
    : Match.value(decision).pipe(
        Match.tag("Probability", (): DecisionModel.ProviderAnswer => ({
          _tag: "Probability",
          probability,
        })),
        Match.tag("Rate", ({ criteria }): DecisionModel.ProviderAnswer => ({
          _tag: "Rate",
          confidence: 0.9,
          probabilities: oneHot(Array.map(criteria, Struct.get("label"))),
          rating: 0,
        })),
        Match.tag("Classify", ({ criteria }): DecisionModel.ProviderAnswer => {
          const labels = Record.keys(criteria);
          return {
            _tag: "Classify",
            confidence: 0.9,
            label: Option.getOrElse(Array.head(labels), () => ""),
            probabilities: oneHot(labels),
          };
        }),
        Match.exhaustive,
      );

const scripted = ({
  failures = [],
  probability = () => 0.9,
  refuse = [],
  takes = Duration.zero,
}: Script = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<DecisionModel.ProviderOptions>>([]);
      const inFlight = yield* Ref.make(0);
      const most = yield* Ref.make(0);
      const model = yield* DecisionModel.make({
        decide: (options) =>
          Effect.gen(function* () {
            const call = yield* Ref.modify(seen, (calls) => [
              Array.length(calls),
              Array.append(calls, options),
            ]);
            const now = yield* Ref.updateAndGet(inFlight, Number.increment);
            yield* Ref.update(most, (before) => Number.max(before, now));
            yield* Effect.sleep(takes);
            yield* Ref.update(inFlight, Number.decrement);
            const failure = Array.get(failures, call);
            if (Option.isSome(failure)) {
              return yield* failure.value;
            }
            return {
              answers: Record.map(options.decisions, (decision, name) =>
                answerFor(name, decision, refuse, probability(options.state)),
              ),
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }),
      });
      return Layer.mergeAll(
        Layer.succeed(DecisionModel.DecisionModel, model),
        Layer.succeed(Calls, Calls.of({ most: Ref.get(most), seen: Ref.get(seen) })),
      );
    }),
  );

const configOf = Schema.decodeSync(CairnConfig);
const defaults = configOf({});

/** A judge over the scripted model, with `Calls` to read what it was asked. */
const judging = (script: Script = {}, config: CairnConfig = defaults) =>
  Judge.layerWith(config).pipe(Layer.provideMerge(scripted(script)));

const none: Judgments = { judgments: [], model: defaults.judge.model, version: 1 };

const seenOf = Calls.use((calls) => calls.seen);
const seenCount = Effect.map(seenOf, Array.length);
const mostOf = Calls.use((calls) => calls.most);

/** Generated inputs, with each section and task ID once, as `inputsOf` gives them. */
const Inputs = Schema.Struct({
  prdSections: Schema.Array(
    Schema.Struct({ id: PrdSectionId, input: PrdSectionJudgingInput }),
  ).check(Schema.isMaxLength(3)),
  sections: Schema.Array(Schema.Struct({ id: SpecSectionId, input: SectionJudgingInput })).check(
    Schema.isMaxLength(3),
  ),
  stack: StackJudgingInput,
  tasks: Schema.Array(Schema.Struct({ id: TaskId, input: TaskJudgingInput })).check(
    Schema.isMaxLength(3),
  ),
});

const unique = (inputs: typeof Inputs.Type): JudgingInputs =>
  Struct.evolve(inputs, {
    prdSections: (prdSections) => Array.dedupeWith(prdSections, (a, b) => a.id === b.id),
    sections: (sections) => Array.dedupeWith(sections, (a, b) => a.id === b.id),
    tasks: (tasks) => Array.dedupeWith(tasks, (a, b) => a.id === b.id),
  });

const section = (id: string, body: string) => ({
  id: SpecSectionId.make(id),
  input: { body, files: ["packages/cli/src/judge.ts"], implements: [], title: id },
});

const stack: StackJudgingInput = {
  feature: StackJudgingInput.fields.feature.make("cairn-mvp"),
  goal: "Judge the plan",
  prdSections: [],
  tasks: [],
};

const task = (id: string) => ({
  id: TaskId.make(id),
  input: {
    dependsOn: [],
    files: [],
    others: [],
    prdSections: [],
    specSections: [],
    title: `Task ${id}`,
  },
});

const prdSection = (id: string, body: string) => ({
  id: PrdSectionId.make(id),
  input: {
    body,
    tasks: [
      { files: ["packages/cli/src/judge.ts"], specSections: ["Judge service"], title: "Task t1" },
    ],
    title: id,
  },
});

const fixed: JudgingInputs = {
  prdSections: [],
  sections: [section("spec.a", "First"), section("spec.b", "Second")],
  stack,
  tasks: [task("t1")],
};

const decisionsOf = (options: DecisionModel.ProviderOptions) =>
  Array.sort(Record.keys(options.decisions), Order.String);

it.effect.prop(
  "every target is asked once with all its questions, and each answer is a judgment with its verdict",
  [Inputs],
  ([generated]) =>
    Effect.gen(function* () {
      const inputs = unique(generated);
      const judge = yield* Judge;
      const result = yield* judge.judge(inputs, none);
      const seen = yield* seenOf;

      expect(Array.map(seen, decisionsOf)).toEqual(
        Array.flatten([
          Array.map(inputs.sections, () => ["buildable", "faithful", "inScope", "size"]),
          Array.map(inputs.tasks, () => [
            "category",
            "inScope",
            "matches",
            "model",
            "ordered",
            "reasoning",
            "size",
          ]),
          Array.map(inputs.prdSections, () => ["built"]),
          [["oneFeature"]],
        ]),
      );
      expect(Schema.is(Judgments)(result)).toBe(true);
      expect(result.model).toBe("jev-1.14.0");
      expect(
        Array.every(
          result.judgments,
          (judgment) => judgment.round === 1 && judgment.action === "none",
        ),
      ).toBe(true);
      expect(Array.length(result.judgments)).toBe(
        4 * Array.length(inputs.sections) +
          7 * Array.length(inputs.tasks) +
          Array.length(inputs.prdSections) +
          1,
      );
      expect(
        Array.map(result.judgments, (judgment) => Struct.pick(judgment, ["message", "verdict"])),
      ).toEqual(
        Array.map(result.judgments, (judgment) =>
          verdictOf(judgment.question, judgment.answer, defaults.judge),
        ),
      );
    }).pipe(Effect.provide(judging())),
  { arbitrary: { runs: 20 } },
);

it.effect.prop(
  "judging again with the last judgments as previous asks nothing and keeps every judgment",
  [Inputs],
  ([generated]) =>
    Effect.gen(function* () {
      const inputs = unique(generated);
      const judge = yield* Judge;
      const first = yield* judge.judge(inputs, none);
      const asked = yield* seenCount;
      const second = yield* judge.judge(inputs, first);
      const askedAgain = yield* seenCount;
      expect(askedAgain).toBe(asked);
      expect(second).toEqual(first);
    }).pipe(Effect.provide(judging())),
  { arbitrary: { runs: 20 } },
);

/** The judgments of one section. */
const judgmentsOf = (judgments: Judgments, id: string) =>
  Array.filter(judgments.judgments, (j) => j.target.kind === "section" && j.target.id === id);

it.effect("a changed target is asked again and the unchanged ones are kept", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const first = yield* judge.judge(fixed, none);
    const changed = Struct.evolve(fixed, {
      sections: (sections) =>
        Array.map(sections, (entry) =>
          entry.id === "spec.b" ? section("spec.b", "Second, rewritten") : entry,
        ),
    });
    const second = yield* judge.judge(changed, first);
    const seen = yield* seenOf;

    expect(Array.length(seen)).toBe(4 + 1);
    expect(Option.map(Array.last(seen), (options) => options.state)).toEqual(
      Option.some(section("spec.b", "Second, rewritten").input),
    );
    expect(judgmentsOf(second, "spec.a")).toEqual(judgmentsOf(first, "spec.a"));
    expect(Array.map(judgmentsOf(second, "spec.b"), (j) => j.inputHash)).not.toEqual(
      Array.map(judgmentsOf(first, "spec.b"), (j) => j.inputHash),
    );
    expect(Array.length(second.judgments)).toBe(Array.length(first.judgments));
  }).pipe(Effect.provide(judging())),
);

it.effect("a target is asked again when a question it asks now has no previous judgment", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const first = yield* judge.judge(fixed, none);
    const withoutModel = Struct.evolve(first, {
      judgments: (judgments) => Array.filter(judgments, (j) => j.question !== "model"),
    });
    yield* judge.judge(fixed, withoutModel);
    const seen = yield* seenOf;
    expect(Array.length(seen)).toBe(4 + 1);
    expect(Option.map(Array.last(seen), (options) => options.state)).toEqual(
      Option.some(task("t1").input),
    );
  }).pipe(Effect.provide(judging())),
);

/** The judgments of one PRD section. */
const judgmentsOfPrd = (judgments: Judgments, id: string) =>
  Array.filter(judgments.judgments, (j) => j.target.kind === "prd" && j.target.id === id);

const withPrd: JudgingInputs = Struct.evolve(fixed, {
  prdSections: () => [prdSection("prd.a", "Judge the plan"), prdSection("prd.b", "Show it")],
});

it.effect(
  "a PRD section is asked built in a request of its own, kept when unchanged and asked again when changed",
  () =>
    Effect.gen(function* () {
      const judge = yield* Judge;
      const first = yield* judge.judge(withPrd, none);
      const asked = yield* seenOf;
      expect(
        Array.map(
          Array.filter(asked, (options) => Record.has(options.decisions, "built")),
          (options) => [decisionsOf(options), options.state] as const,
        ),
      ).toEqual([
        [["built"], prdSection("prd.a", "Judge the plan").input],
        [["built"], prdSection("prd.b", "Show it").input],
      ]);
      expect(
        Array.map(judgmentsOfPrd(first, "prd.a"), (j) => [j.question, j.target] as const),
      ).toEqual([["built", { id: "prd.a", kind: "prd" }]]);

      const again = yield* judge.judge(withPrd, first);
      const askedAgain = yield* seenCount;
      expect([askedAgain, again]).toEqual([Array.length(asked), first]);

      const changed = Struct.evolve(withPrd, {
        prdSections: (prdSections) =>
          Array.map(prdSections, (entry) =>
            entry.id === "prd.b" ? prdSection("prd.b", "Show it, rewritten") : entry,
          ),
      });
      const third = yield* judge.judge(changed, first);
      const seen = yield* seenOf;
      expect(Array.length(seen)).toBe(Array.length(asked) + 1);
      expect(Option.map(Array.last(seen), (options) => options.state)).toEqual(
        Option.some(prdSection("prd.b", "Show it, rewritten").input),
      );
      expect(judgmentsOfPrd(third, "prd.a")).toEqual(judgmentsOfPrd(first, "prd.a"));
      expect(Array.map(judgmentsOfPrd(third, "prd.b"), (j) => j.inputHash)).not.toEqual(
        Array.map(judgmentsOfPrd(first, "prd.b"), (j) => j.inputHash),
      );
    }).pipe(Effect.provide(judging())),
);

it.effect.prop(
  "with asks, each target is asked and kept only the questions asks holds true, and one left with none is not asked",
  [
    Schema.Array(
      Schema.Literals(["built", "ordered", "oneFeature", "size", "matches", "faithful"]),
    ),
  ],
  ([kept]) => {
    const asks = (question: string) => Array.contains<string>(kept, question);
    return Effect.gen(function* () {
      const judge = yield* Judge;
      const result = yield* judge.judge(withPrd, none, { asks });
      const seen = yield* seenOf;
      expect(Array.every(Array.flatMap(seen, decisionsOf), asks)).toBe(true);
      expect(Array.every(seen, (options) => Record.size(options.decisions) > 0)).toBe(true);
      expect(Array.every(result.judgments, (j) => asks(j.question))).toBe(true);
      const everything = yield* judge.judge(withPrd, none);
      expect(Array.filter(everything.judgments, (j) => asks(j.question))).toHaveLength(
        Array.length(result.judgments),
      );
      const asked = yield* seenCount;
      const again = yield* judge.judge(withPrd, result, { asks });
      const askedAgain = yield* seenCount;
      expect(again).toEqual(result);
      expect(askedAgain).toBe(asked);
    }).pipe(Effect.provide(judging()));
  },
  { arbitrary: { runs: 20 } },
);

/** Judges `fixed` under `before`, then again under `after` with the first judgments as previous. */
const rejudged = (before: CairnConfig, after: CairnConfig) =>
  Effect.gen(function* () {
    const first = yield* Judge.use((judge) => judge.judge(fixed, none)).pipe(
      Effect.provide(judging({}, before)),
    );
    return yield* Effect.gen(function* () {
      const second = yield* Judge.use((judge) => judge.judge(fixed, first));
      const seen = yield* seenOf;
      return { first, second, seen };
    }).pipe(Effect.provide(judging({}, after)));
  });

const withModels = (models: Record<string, string>) => configOf({ judge: { models } });

/** The requests `seen` gives, as the decisions each asked for. */
const askedFor = (seen: ReadonlyArray<DecisionModel.ProviderOptions>) =>
  Array.map(seen, decisionsOf);

it.effect("a task is asked again when judge.models names other models", () =>
  Effect.gen(function* () {
    const { second, seen } = yield* rejudged(
      withModels({ haiku: "Small", opus: "Large", sonnet: "Most" }),
      withModels({ fable: "New", haiku: "Small", sonnet: "Most" }),
    );
    expect(Array.map(seen, (options) => options.state)).toEqual([task("t1").input]);
    const labels = Array.map(
      Array.filter(second.judgments, (j) => j.question === "model"),
      (j) =>
        Predicate.hasProperty(j.answer, "probabilities")
          ? Array.sort(Record.keys(j.answer.probabilities), Order.String)
          : [],
    );
    expect(labels).toEqual([["fable", "haiku", "sonnet"]]);
  }),
);

it.effect("a task is asked again when only a model's description in judge.models changes", () =>
  Effect.gen(function* () {
    const { seen } = yield* rejudged(
      withModels({ haiku: "Small", sonnet: "Most" }),
      withModels({ haiku: "Small, mechanical changes only", sonnet: "Most" }),
    );
    expect(Array.map(seen, (options) => options.state)).toEqual([task("t1").input]);
    expect(Array.map(seen, (options) => Record.get(options.decisions, "model"))).toEqual([
      Option.some(
        expect.objectContaining({
          criteria: { haiku: "Small, mechanical changes only", sonnet: "Most" },
        }),
      ),
    ]);
  }),
);

it.effect("nothing is asked again when judge.models is the same, in any order", () =>
  Effect.gen(function* () {
    const { first, second, seen } = yield* rejudged(
      withModels({ haiku: "Small", opus: "Large", sonnet: "Most" }),
      withModels({ sonnet: "Most", opus: "Large", haiku: "Small" }),
    );
    expect(Array.length(seen)).toBe(0);
    expect(second).toEqual(first);
  }),
);

/** The judgments of every target but the tasks. */
const notTask = (judgments: Judgments) =>
  Array.filter(judgments.judgments, (j) => j.target.kind !== "task");

it.effect("a task is asked again without its model question once judge.models names one", () =>
  Effect.gen(function* () {
    const { first, second, seen } = yield* rejudged(
      withModels({ haiku: "Small", sonnet: "Most" }),
      withModels({ haiku: "Small" }),
    );
    expect(Array.map(seen, (options) => options.state)).toEqual([task("t1").input]);
    expect(askedFor(seen)).toEqual([
      ["category", "inScope", "matches", "ordered", "reasoning", "size"],
    ]);
    expect(notTask(second)).toEqual(notTask(first));
    expect(
      Array.map(
        Array.filter(second.judgments, (j) => j.target.kind === "task"),
        (j) => j.question,
      ),
    ).toEqual(["inScope", "matches", "ordered", "reasoning", "size", "category"]);
  }),
);

const withCategories = (categories: Record<string, string>) =>
  configOf({
    categories: Array.map(Record.toEntries(categories), ([name, description]) => ({
      description,
      name,
    })),
  });

it.effect("a task is asked again when only a category's description changes", () =>
  Effect.gen(function* () {
    const { seen } = yield* rejudged(
      withCategories({ feature: "New behaviour", ui: "Interface" }),
      withCategories({ feature: "New behaviour a person can use", ui: "Interface" }),
    );
    expect(Array.map(seen, (options) => options.state)).toEqual([task("t1").input]);
    expect(Array.map(seen, (options) => Record.get(options.decisions, "category"))).toEqual([
      Option.some(
        expect.objectContaining({
          criteria: { feature: "New behaviour a person can use", ui: "Interface" },
        }),
      ),
    ]);
  }),
);

it.effect("nothing is asked again when config.categories is the same, in any order", () =>
  Effect.gen(function* () {
    const { first, second, seen } = yield* rejudged(
      withCategories({ feature: "New", ui: "Interface" }),
      withCategories({ ui: "Interface", feature: "New" }),
    );
    expect(Array.length(seen)).toBe(0);
    expect(second).toEqual(first);
  }),
);

it.effect.prop(
  "a task's category question is asked only when config.categories names two or more",
  [Schema.Literals([0, 1, 2, 3])],
  ([count]) => {
    const categories = Record.fromIterableWith(Array.range(1, count), (n) => [
      `c${n}`,
      `Category ${n}`,
    ]);
    return Effect.gen(function* () {
      const judge = yield* Judge;
      const result = yield* judge.judge(fixed, none);
      const seen = yield* seenOf;
      const asks = Array.some(seen, (options) => Record.has(options.decisions, "category"));
      const judged = Array.some(result.judgments, (j) => j.question === "category");
      expect([asks, judged]).toEqual([count >= 2, count >= 2]);
    }).pipe(Effect.provide(judging({}, withCategories(categories))));
  },
);

/** A catalog as `judge.models` holds it. */
const Catalog = Schema.Record(Schema.String, Schema.String).check(Schema.isMaxProperties(4));

it.effect.prop(
  "a change to judge.models asks every task again and no section or the stack",
  [Catalog, Catalog],
  ([before, after]) =>
    Effect.gen(function* () {
      const { seen } = yield* rejudged(withModels(before), withModels(after));
      const same = Equal.equals(before, after);
      expect(Array.map(seen, (options) => options.state)).toEqual(same ? [] : [task("t1").input]);
    }),
  { arbitrary: { runs: 20 } },
);

it.effect("a model judgment is dropped once the question is not asked, whatever its labels", () =>
  Effect.gen(function* () {
    const kept = yield* Judge.use((judge) => judge.judge(fixed, none));
    const previous = Struct.evolve(kept, {
      judgments: (judgments) =>
        Array.append(judgments, {
          action: "none" as const,
          answer: { confidence: 0.9, label: "haiku", probabilities: { haiku: 1 } },
          at: DateTime.makeUnsafe(0),
          inputHash: Option.getOrThrow(Array.findFirst(judgments, (j) => j.target.kind === "task"))
            .inputHash,
          message: "model haiku",
          question: "model" as const,
          round: 1,
          target: { id: TaskId.make("t1"), kind: "task" as const },
          verdict: "pass" as const,
        }),
    });
    const second = yield* Judge.use((judge) => judge.judge(fixed, previous));
    const asked = yield* seenCount;
    expect(asked).toBe(4);
    expect(second).toEqual(kept);
  }).pipe(Effect.provide(judging({}, withModels({ haiku: "Small" })))),
);

it.effect("judgments a different model gave are not kept", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const first = yield* judge.judge(fixed, none);
    yield* judge.judge(fixed, Struct.evolve(first, { model: () => "jev-1.13.0" }));
    const asked = yield* seenCount;
    expect(asked).toBe(2 * 4);
  }).pipe(Effect.provide(judging())),
);

it.effect("the input hash is the SHA-256 in hex of the input encoded as JSON", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const result = yield* judge.judge(fixed, none);
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(SectionJudgingInput))(
      section("spec.a", "First").input,
    );
    const expected = createHash("sha256").update(encoded).digest("hex");
    const hashes = Array.dedupe(
      Array.filterMap(result.judgments, (j) =>
        j.target.kind === "section" && j.target.id === "spec.a"
          ? Result.succeed(j.inputHash)
          : Result.failVoid,
      ),
    );
    expect(hashes).toEqual([expected]);
  }).pipe(Effect.provide(judging())),
);

it.effect.prop(
  "inputHashesOf gives each target the inputHash of every judgment the judge gives it",
  [Inputs, Catalog],
  ([generated, models]) =>
    Effect.gen(function* () {
      const inputs = unique(generated);
      const config = withModels(models);
      const result = yield* Judge.use((judge) => judge.judge(inputs, none)).pipe(
        Effect.provide(judging({}, config)),
      );
      const hashes = yield* inputHashesOf(inputs, config);
      expect(
        Array.map(result.judgments, (j) =>
          Array.findFirst(hashes, ({ target }) => Equal.equals(target, j.target)).pipe(
            Option.map(({ hash }) => hash),
          ),
        ),
      ).toEqual(Array.map(result.judgments, (j) => Option.some(j.inputHash)));
      expect(Array.length(hashes)).toBe(
        Array.length(inputs.sections) +
          Array.length(inputs.tasks) +
          Array.length(inputs.prdSections) +
          1,
      );
    }),
  { arbitrary: { runs: 20 } },
);

it.effect.prop(
  "a task's model question is asked only when judge.models names two models or more",
  [Schema.Literals([0, 1, 2, 3])],
  ([count]) => {
    const models = Record.fromIterableWith(Array.range(1, count), (n) => [`m${n}`, `Model ${n}`]);
    const config = configOf({ judge: { models: count === 0 ? {} : models } });
    return Effect.gen(function* () {
      const judge = yield* Judge;
      const result = yield* judge.judge(fixed, none);
      const seen = yield* seenOf;
      const asksModel = Array.some(seen, (options) => Record.has(options.decisions, "model"));
      const judgedModel = Array.some(result.judgments, (j) => j.question === "model");
      expect([asksModel, judgedModel]).toEqual([count >= 2, count >= 2]);
      expect(Array.length(seen)).toBe(4);
    }).pipe(Effect.provide(judging({}, config)));
  },
);

it.effect("no more than four requests are in flight at once", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const inputs: JudgingInputs = {
      prdSections: [],
      sections: Array.map(Array.range(1, 10), (n) => section(`spec.s${n}`, `Body ${n}`)),
      stack,
      tasks: [],
    };
    const fiber = yield* Effect.forkChild(judge.judge(inputs, none));
    yield* TestClock.adjust(Duration.seconds(10));
    yield* Fiber.join(fiber);
    const most = yield* mostOf;
    const asked = yield* seenCount;
    expect([most, asked]).toEqual([4, 11]);
  }).pipe(Effect.provide(judging({ takes: Duration.seconds(1) }))),
);

const rateLimited = (retryAfter?: Duration.Duration) =>
  AiError.make({
    method: "decide",
    module: "ScriptedDecisionModel",
    reason: new AiError.RateLimitError(
      Option.match(Option.fromUndefinedOr(retryAfter), {
        onNone: () => ({}),
        onSome: (delay) => ({ retryAfter: delay }),
      }),
    ),
  });

/** Moves the test clock on and reads how many calls the model has had. */
const after = (seconds: number) =>
  Effect.andThen(TestClock.adjust(Duration.seconds(seconds)), seenCount);

const stackOnly: JudgingInputs = { prdSections: [], sections: [], stack, tasks: [] };

it.effect("a rate limit is retried three times, each after the delay the provider gives", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const fiber = yield* Effect.forkChild(judge.judge(stackOnly, none));
    const counts = yield* Effect.forEach([0, 29, 1, 30, 30], after);
    expect(counts).toEqual([1, 1, 2, 3, 4]);
    const result = yield* Fiber.join(fiber);
    expect(Array.length(result.judgments)).toBe(1);
  }).pipe(
    Effect.provide(judging({ failures: Array.replicate(rateLimited(Duration.seconds(30)), 3) })),
  ),
);

it.effect("a rate limit with no delay is retried after a second", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const fiber = yield* Effect.forkChild(judge.judge(stackOnly, none));
    yield* TestClock.adjust(Duration.millis(999));
    const before = yield* seenCount;
    yield* TestClock.adjust(Duration.millis(1));
    yield* Fiber.join(fiber);
    const retried = yield* seenCount;
    expect([before, retried]).toEqual([1, 2]);
  }).pipe(Effect.provide(judging({ failures: [rateLimited()] }))),
);

it.effect("a fourth rate limit fails with a JudgeError that names the target", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const fiber = yield* Effect.forkChild(judge.judge(stackOnly, none));
    yield* TestClock.adjust(Duration.seconds(120));
    const error = yield* Effect.flip(Fiber.join(fiber));
    const asked = yield* seenCount;
    expect(asked).toBe(4);
    expect(error.target).toEqual({ kind: "stack" } satisfies JudgmentTarget);
    expect(error.message).toContain("the stack");
  }).pipe(
    Effect.provide(judging({ failures: Array.replicate(rateLimited(Duration.seconds(30)), 4) })),
  ),
);

it.effect("any other AiError fails at once with a JudgeError that names the target", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const error = yield* Effect.flip(
      judge.judge(
        { prdSections: [], sections: [section("spec.a", "First")], stack, tasks: [] },
        none,
      ),
    );
    expect(Schema.is(JudgeError)(error)).toBe(true);
    expect(error.target).toEqual({ id: "spec.a", kind: "section" });
    expect(error.message).toContain("section spec.a");
    const asked = yield* seenCount;
    expect(asked).toBe(1);
  }).pipe(
    Effect.provide(
      judging({
        failures: [
          AiError.make({
            method: "decide",
            module: "ScriptedDecisionModel",
            reason: new AiError.InvalidRequestError({ description: "Bad request" }),
          }),
        ],
      }),
    ),
  ),
);

it.effect("a refused question is an unanswered judgment, unsure", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const result = yield* judge.judge(stackOnly, none);
    const oneFeature = Array.findFirst(result.judgments, (j) => j.question === "oneFeature");
    expect(Option.map(oneFeature, (j) => [j.answer, j.verdict])).toEqual(
      Option.some([{ description: expect.any(String), unanswered: "Refused" }, "unsure"]),
    );
  }).pipe(Effect.provide(judging({ refuse: ["oneFeature"] }))),
);

it.effect(
  "the live judge with judge.gatewayTokenEnv unset in the environment names that variable",
  () =>
    Effect.gen(function* () {
      const config = configOf({
        judge: { baseUrl: "https://gateway.test", gatewayTokenEnv: "GW_TOKEN" },
      });
      const error = yield* Effect.flip(Layer.build(Judge.live(config)).pipe(Effect.scoped));
      expect(Schema.is(JudgeError)(error)).toBe(true);
      expect(error.message).toContain("GW_TOKEN");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))),
);

it.effect("the live judge without TYPESAFE_API_KEY fails with a JudgeError that names it", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(Layer.build(Judge.live(defaults)).pipe(Effect.scoped));
    expect(Schema.is(JudgeError)(error)).toBe(true);
    expect(error.message).toContain("TYPESAFE_API_KEY");
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))),
);

it.effect("whenConfigured provides a Judge only when a key or a gateway token is configured", () =>
  Effect.forEach(
    [
      { config: defaults, env: {}, provided: false },
      { config: defaults, env: { TYPESAFE_API_KEY: "key" }, provided: true },
      {
        config: configOf({
          judge: { baseUrl: "https://gateway.test", gatewayTokenEnv: "GW_TOKEN" },
        }),
        env: { GW_TOKEN: "token" },
        provided: true,
      },
    ],
    ({ config, env, provided }) =>
      Layer.build(Judge.whenConfigured(config)).pipe(
        Effect.scoped,
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        Effect.map((context) =>
          expect(Option.isSome(Context.getOption(context, Judge))).toBe(provided),
        ),
      ),
    { discard: true },
  ),
);

/** A definition with one yes-or-no decision, whose scripted probability is the input's `n` over ten. */
const Numbered = Decision.make({
  decisions: { holds: Decision.probability({ instructions: "Does it hold?" }) },
  input: Schema.Struct({ n: Schema.Int }),
});

const tenths = (state: Schema.Json) =>
  Predicate.hasProperty(state, "n") && Predicate.isNumber(state.n)
    ? Number.divideUnsafe(state.n, 10)
    : 0;

const labelled = (ns: ReadonlyArray<number>) =>
  Array.map(ns, (n) => ({ input: { n }, label: `input ${n}` }));

const probabilityOfOutcome = (outcome: Decision.Outcome<Decision.Probability>) =>
  Result.match(outcome, { onFailure: () => -1, onSuccess: Struct.get("probability") });

it.effect.prop(
  "ask gives each input's outcomes in input order, however the answers differ",
  [Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 0 })))],
  ([ns]) =>
    Effect.gen(function* () {
      const judge = yield* Judge;
      const outcomes = yield* judge.ask(Numbered, labelled(ns));
      expect(Array.map(outcomes, ({ holds }) => probabilityOfOutcome(holds))).toEqual(
        Array.map(ns, (n) => Number.divideUnsafe(n, 10)),
      );
      const asked = yield* seenCount;
      expect(asked).toBe(Array.length(ns));
    }).pipe(Effect.provide(judging({ probability: tenths }))),
);

it.effect("an unanswered decision reads as unsure through yesNoOf", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const outcomes = yield* judge.ask(Numbered, labelled([10, 0]));
    expect(Array.map(outcomes, ({ holds }) => yesNoOf(holds, defaults.judge))).toEqual([
      "unsure",
      "unsure",
    ]);
  }).pipe(Effect.provide(judging({ refuse: ["holds"] }))),
);

it.effect("ask reads each answer through yesNoOf against pass and flag", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const outcomes = yield* judge.ask(Numbered, labelled([10, 5, 0]));
    expect(Array.map(outcomes, ({ holds }) => yesNoOf(holds, defaults.judge))).toEqual([
      "yes",
      "unsure",
      "no",
    ]);
  }).pipe(Effect.provide(judging({ probability: tenths }))),
);

it.effect("ask retries a rate limit after the delay the provider gives", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const fiber = yield* Effect.forkChild(judge.ask(Numbered, labelled([7])));
    yield* TestClock.adjust(Duration.seconds(29));
    const before = yield* seenCount;
    yield* TestClock.adjust(Duration.seconds(1));
    const outcomes = yield* Fiber.join(fiber);
    const retried = yield* seenCount;
    expect([before, retried]).toEqual([1, 2]);
    expect(Array.map(outcomes, ({ holds }) => probabilityOfOutcome(holds))).toEqual([0.7]);
  }).pipe(
    Effect.provide(judging({ failures: [rateLimited(Duration.seconds(30))], probability: tenths })),
  ),
);

it.effect("ask fails at once on any other AiError, with a JudgeError that names the input", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const error = yield* Effect.flip(
      judge.ask(Numbered, [{ input: { n: 1 }, label: "prd.cli.doctor" }]),
    );
    expect(Schema.is(JudgeError)(error)).toBe(true);
    expect(error.message).toContain("prd.cli.doctor");
    const asked = yield* seenCount;
    expect(asked).toBe(1);
  }).pipe(
    Effect.provide(
      judging({
        failures: [
          AiError.make({
            method: "decide",
            module: "ScriptedDecisionModel",
            reason: new AiError.InvalidRequestError({ description: "Bad request" }),
          }),
        ],
      }),
    ),
  ),
);

it.effect("ask sends no more than four requests at once", () =>
  Effect.gen(function* () {
    const judge = yield* Judge;
    const fiber = yield* Effect.forkChild(
      judge.ask(Numbered, labelled([1, 2, 3, 4, 5, 6, 7, 8, 9])),
    );
    yield* TestClock.adjust(Duration.seconds(10));
    yield* Fiber.join(fiber);
    const most = yield* mostOf;
    const asked = yield* seenCount;
    expect([most, asked]).toEqual([4, 9]);
  }).pipe(Effect.provide(judging({ takes: Duration.seconds(1) }))),
);
