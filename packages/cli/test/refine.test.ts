import { Config as CairnConfig, PrdSectionId, SpecSectionId, TaskDraft } from "@cairn/contract";
import type { Judgment } from "@cairn/contract";
import { sectionIdsOf, sectionsOf } from "@cairn/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  ConfigProvider,
  Context,
  Effect,
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
  String,
  Struct,
  pipe,
} from "effect";
import { DecisionModel } from "effect/ai";
import type { Decision } from "effect/ai";

import { Judge } from "../src/judge.ts";
import { Planner, SplitDrafts } from "../src/planner.ts";
import { refine, refineWith } from "../src/refine.ts";
import type { RefineInput } from "../src/refine.ts";
import {
  Script as ModelScript,
  scripted as scriptedModel,
  turnsOf,
} from "./fixtures/scripted-language-model.ts";
import { stubPlanner } from "./fixtures/stub-planner.ts";

/**
 * Nothing here reads a key or touches the network. The judge is `Judge.layerWith` over
 * `DecisionModel.make` with a scripted `decide`, and the planner splits by script. Both record
 * what they were asked.
 */
class Calls extends Context.Service<
  Calls,
  {
    /** The titles of the inputs the decision model was asked about, the stack's as "". */
    readonly decided: Effect.Effect<ReadonlyArray<string>>;
    /** The sections `splitSection` was given. */
    readonly sectionSplits: Effect.Effect<ReadonlyArray<string>>;
    /** The titles of the drafts `splitTask` was given. */
    readonly taskSplits: Effect.Effect<ReadonlyArray<string>>;
  }
>()("@cairn/cli/test/refine/Calls") {}

/** A rated or classified answer: the label and the confidence the model gives it. */
interface Pick {
  readonly confidence: number;
  readonly label: string;
}

interface Script {
  /** The answer to a rated or classified question about the target titled `title`. */
  readonly answer?: (title: string, question: string) => Option.Option<Pick>;
  /** The probability of a yes-or-no question about the target titled `title`; none keeps 0.9. */
  readonly probability?: (title: string, question: string) => Option.Option<number>;
  readonly splitSection?: (section: string) => string;
  readonly splitTask?: (draft: TaskDraft) => ReadonlyArray<TaskDraft>;
}

/** Sized right, and too unsure about a model or a reasoning level to change one. */
const defaultPick = (question: string, labels: ReadonlyArray<string>): Pick =>
  question === "size"
    ? { confidence: 0.9, label: "right" }
    : { confidence: 0.1, label: Option.getOrElse(Array.head(labels), () => "") };

/** The chosen label has `probability`; the others share the rest, so the distribution sums to 1. */
const oneHot = (labels: ReadonlyArray<string>, chosen: string, probability: number) => {
  const others = Number.max(Number.decrement(Array.length(labels)), 1);
  return Record.fromEntries(
    Array.map(
      labels,
      (label) =>
        [
          label,
          label === chosen
            ? Array.length(labels) > 1
              ? probability
              : 1
            : Number.divideUnsafe(Number.subtract(1, probability), others),
        ] as const,
    ),
  );
};

const answerFor = (
  title: string,
  name: string,
  decision: Exclude<Decision.Any, Decision.Locate>,
  script: Script,
): DecisionModel.ProviderAnswer => {
  const pick = (labels: ReadonlyArray<string>) =>
    Option.getOrElse(
      Option.flatMap(Option.fromUndefinedOr(script.answer), (answer) => answer(title, name)),
      () => defaultPick(name, labels),
    );
  return Match.value(decision).pipe(
    Match.tag("Probability", (): DecisionModel.ProviderAnswer => ({
      _tag: "Probability",
      probability: Option.getOrElse(
        Option.flatMap(Option.fromUndefinedOr(script.probability), (say) => say(title, name)),
        () => 0.9,
      ),
    })),
    Match.tag("Rate", ({ criteria }): DecisionModel.ProviderAnswer => {
      const labels = Array.map(criteria, Struct.get("label"));
      const { confidence, label } = pick(labels);
      return {
        _tag: "Rate",
        confidence,
        probabilities: oneHot(labels, label, confidence),
        rating: Option.getOrElse(
          Array.findFirstIndex(labels, (each) => each === label),
          () => 0,
        ),
      };
    }),
    Match.tag("Classify", ({ criteria }): DecisionModel.ProviderAnswer => {
      const labels = Record.keys(criteria);
      const { confidence, label } = pick(labels);
      return {
        _tag: "Classify",
        confidence,
        label,
        probabilities: oneHot(labels, label, confidence),
      };
    }),
    Match.exhaustive,
  );
};

const titleOf = (state: unknown) =>
  Predicate.hasProperty(state, "title") && Predicate.isString(state.title) ? state.title : "";

const scripted = (script: Script) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const decided = yield* Ref.make<ReadonlyArray<string>>([]);
      const sectionSplits = yield* Ref.make<ReadonlyArray<string>>([]);
      const taskSplits = yield* Ref.make<ReadonlyArray<string>>([]);
      const model = yield* DecisionModel.make({
        decide: (options) =>
          Effect.gen(function* () {
            const title = titleOf(options.state);
            yield* Ref.update(decided, Array.append(title));
            return {
              answers: Record.map(options.decisions, (decision, name) =>
                answerFor(title, name, decision, script),
              ),
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }),
      });
      const planner = stubPlanner({
        splitSection: (section) =>
          Effect.as(
            Ref.update(sectionSplits, Array.append(section)),
            Option.getOrElse(
              Option.map(Option.fromUndefinedOr(script.splitSection), (split) => split(section)),
              () => section,
            ),
          ),
        splitTask: (draft) =>
          Effect.as(
            Ref.update(taskSplits, Array.append(draft.title)),
            Option.getOrElse(
              Option.map(Option.fromUndefinedOr(script.splitTask), (split) => split(draft)),
              () => [draft],
            ),
          ),
      });
      return Layer.mergeAll(
        Layer.succeed(DecisionModel.DecisionModel, model),
        Layer.succeed(Planner, planner),
        Layer.succeed(
          Calls,
          Calls.of({
            decided: Ref.get(decided),
            sectionSplits: Ref.get(sectionSplits),
            taskSplits: Ref.get(taskSplits),
          }),
        ),
      );
    }),
  );

const configOf = Schema.decodeSync(CairnConfig);
const defaults = configOf({});

const testing = (script: Script, config: CairnConfig = defaults) =>
  Judge.layerWith(config).pipe(Layer.provideMerge(scripted(script)));

const taskSplitsOf = Calls.use((calls) => calls.taskSplits);
const sectionSplitsOf = Calls.use((calls) => calls.sectionSplits);
const decidedOf = Calls.use((calls) => calls.decided);

const PRD = `# Cairn

## Judging the plan {#prd.judging-the-plan}

Judge the plan.

## CLI {#prd.cli}

The commands.
`;

const SPEC = `# Cairn spec

## Judging {#spec.judging}

- Implements: \`prd.judging-the-plan\`

### Checkpoints {#spec.judging.checkpoints}

- Implements: \`prd.cli\`
- Files: \`packages/cli/src/refine.ts\`

Refine the spec and drafts.

### Verdicts {#spec.judging.verdicts}

- Files: \`packages/core/src/judging/verdicts.ts\`

Turn answers into verdicts.
`;

const specId = (id: string) => SpecSectionId.make(id);

const draft = (title: string): TaskDraft => ({
  category: "feature",
  dependsOn: [],
  files: ["packages/cli/src/refine.ts", "packages/cli/test/refine.test.ts"],
  model: "sonnet",
  prdSections: [PrdSectionId.make("prd.judging-the-plan")],
  reasoning: "high",
  specSections: [specId("spec.judging.checkpoints"), specId("spec.judging.verdicts")],
  title,
});

/** Nothing written in this run and no drafts: each test evolves what it needs. */
const base: RefineInput = { drafts: [], prd: PRD, spec: SPEC, specGenerated: false, written: [] };

/** A size answer that splits whatever it is asked about, when `title` matches. */
const tooLarge =
  (matches: (title: string) => boolean = () => true) =>
  (title: string, question: string): Option.Option<Pick> =>
    question === "size" && matches(title)
      ? Option.some({ confidence: 0.9, label: "too_large" })
      : Option.none();

/** Two drafts that keep everything `whole` has, the second depending on the first. */
const halves = (whole: TaskDraft): ReadonlyArray<TaskDraft> => [
  Struct.evolve(whole, { title: (title) => `${title} a` }),
  Struct.evolve(whole, {
    dependsOn: () => [`${whole.title} a`],
    title: (title) => `${title} b`,
  }),
];

/** Two sections that keep the keys and text of `section`: its heading text with ` a` and ` b`, no IDs. */
const sectionHalves = (section: string): string => {
  const lines = String.split(section, "\n");
  const unnamed = pipe(Array.headNonEmpty(lines), String.replace(/[ \t]*\{#[^}]+\}$/u, ""));
  const body = Array.join(Array.tailNonEmpty(lines), "\n");
  return `${unnamed} a\n${body}\n\n${unnamed} b\n${body}`;
};

const sizeOf = (judgments: ReadonlyArray<Judgment>, kind: "draft" | "section", name: string) =>
  Array.findFirst(
    judgments,
    (judgment) =>
      judgment.question === "size" &&
      (judgment.target.kind === "draft"
        ? kind === "draft" && judgment.target.title === name
        : judgment.target.kind === "section" && kind === "section" && judgment.target.id === name),
  );

it.effect(
  "one too_large answer causes one split, whose drafts are judged again and take its place",
  () =>
    Effect.gen(function* () {
      const result = yield* refineWith(
        Struct.evolve(base, {
          drafts: () => [
            draft("Refine"),
            Struct.evolve(draft("Plan"), { dependsOn: () => ["Refine"] }),
          ],
        }),
        defaults,
      );
      const splits = yield* taskSplitsOf;
      expect(splits).toEqual(["Refine"]);
      expect(Array.map(result.drafts, (each) => [each.title, each.dependsOn])).toEqual([
        ["Refine a", []],
        ["Refine b", ["Refine a"]],
        ["Plan", ["Refine a", "Refine b"]],
      ]);
      const split = sizeOf(result.judgments, "draft", "Refine");
      expect(Option.map(split, Struct.pick(["action", "round", "verdict"]))).toEqual(
        Option.some({ action: "split", round: 1, verdict: "flag" }),
      );
      expect(Option.map(split, Struct.get("message"))).toEqual(
        Option.some('size is too_large, 0.9; split into 2 drafts: "Refine a", "Refine b"'),
      );
      expect(
        Array.map(["Refine a", "Refine b", "Plan"], (title) =>
          Option.map(sizeOf(result.judgments, "draft", title), Struct.pick(["round", "verdict"])),
        ),
      ).toEqual([
        Option.some({ round: 2, verdict: "pass" }),
        Option.some({ round: 2, verdict: "pass" }),
        Option.some({ round: 1, verdict: "pass" }),
      ]);
    }).pipe(
      Effect.provide(
        testing({ answer: tooLarge((title) => title === "Refine"), splitTask: halves }),
      ),
    ),
);

it.effect("a split that drops a spec section or a file is discarded and the draft kept", () =>
  Effect.gen(function* () {
    const original = draft("Refine");
    const result = yield* refineWith(Struct.evolve(base, { drafts: () => [original] }), defaults);
    expect(result.drafts).toEqual([original]);
    const size = sizeOf(result.judgments, "draft", "Refine");
    expect(Option.map(size, Struct.pick(["action", "verdict"]))).toEqual(
      Option.some({ action: "none", verdict: "flag" }),
    );
    expect(Option.map(size, Struct.get("message"))).toEqual(
      Option.some(
        "size is too_large, 0.9; the split was discarded: it drops spec section spec.judging.verdicts, file packages/cli/test/refine.test.ts",
      ),
    );
    expect(Array.every(result.judgments, (judgment) => judgment.round === 1)).toBe(true);
  }).pipe(
    Effect.provide(
      testing({
        answer: tooLarge(),
        splitTask: (whole) => [
          Struct.evolve(whole, {
            files: () => ["packages/cli/src/refine.ts"],
            specSections: (): TaskDraft["specSections"] => [specId("spec.judging.checkpoints")],
            title: () => "Refine a",
          }),
          Struct.evolve(whole, {
            files: () => ["packages/cli/src/refine.ts"],
            specSections: (): TaskDraft["specSections"] => [specId("spec.judging.checkpoints")],
            title: () => "Refine b",
          }),
        ],
      }),
    ),
  ),
);

it.effect("rounds stop at judge.maxRounds even when every answer is too_large", () =>
  // Every maxRounds from 1 to 3, each with its own judge and planner.
  Effect.forEach([1, 2, 3], (maxRounds) => {
    const config = configOf({ judge: { maxRounds } });
    return Effect.gen(function* () {
      const result = yield* refineWith(
        Struct.evolve(base, {
          drafts: () => [draft("Refine")],
          written: () => [specId("spec.judging.verdicts")],
        }),
        config,
      );
      const splits = yield* taskSplitsOf;
      const sectionSplits = yield* sectionSplitsOf;
      // Each round but the last doubles what it judged.
      const splitCount = 2 ** (maxRounds - 1) - 1;
      const last = 2 ** (maxRounds - 1);
      expect([Array.length(splits), Array.length(sectionSplits)]).toEqual([splitCount, splitCount]);
      expect(Array.length(result.drafts)).toBe(last);
      expect(
        Array.max(
          Array.map(Array.append(result.judgments, { round: 1 }), Struct.get("round")),
          Order.Number,
        ),
      ).toBe(maxRounds);
      const lastSizes = Array.filter(
        result.judgments,
        (judgment) => judgment.question === "size" && judgment.round === maxRounds,
      );
      expect(Array.length(lastSizes)).toBe(2 * last);
      expect(
        Array.every(
          lastSizes,
          (judgment) =>
            judgment.verdict === "flag" &&
            judgment.action === "none" &&
            String.endsWith(`not split: round ${maxRounds} is judge.maxRounds`)(judgment.message),
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        testing({ answer: tooLarge(), splitSection: sectionHalves, splitTask: halves }, config),
      ),
    );
  }),
);

/**
 * The real `Planner` over a scripted model that answers every split with `replies`, in place of
 * the stub: what the model was sent is read back from the model's script.
 */
const plannerOver = (replies: ReadonlyArray<string>) =>
  Planner.layerWith(defaults).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(scriptedModel(Array.map(replies, (reply) => Effect.succeed(reply)))),
  );

const encodeSplit = Schema.encodeSync(Schema.fromJsonString(SplitDrafts));

it.effect(
  "two drafts split in one round each see the spec as the opening and only their own request",
  () =>
    Effect.gen(function* () {
      yield* refineWith(
        Struct.evolve(base, { drafts: () => [draft("Refine"), draft("Plan")] }),
        defaults,
      );
      const requests = yield* ModelScript.use((script) => script.requests);
      const conversations = Array.map(requests, turnsOf);
      expect(Array.length(conversations)).toBe(2);
      const asked = Array.map(conversations, (turns) => {
        expect(Array.map(turns, Struct.get("role"))).toEqual(["system", "user"]);
        const [opening = { text: "" }, own = { text: "" }] = turns;
        expect(opening.text).toContain(SPEC);
        expect(own.text).not.toContain(SPEC);
        return own.text;
      });
      // One request names "Refine" and the other "Plan", and neither names both.
      expect(
        Array.map(asked, (text) => [
          String.includes('"title": "Refine"')(text),
          String.includes('"title": "Plan"')(text),
        ]),
      ).toEqual(
        expect.arrayContaining([
          [true, false],
          [false, true],
        ]),
      );
    }).pipe(
      // The real planner is merged last, so it takes the place of the stub `testing` provides.
      Effect.provide(
        Layer.merge(
          testing({ answer: tooLarge((title) => title === "Refine" || title === "Plan") }),
          plannerOver(Array.replicate(encodeSplit({ drafts: halves(draft("Split")) }), 2)),
        ),
      ),
    ),
);

/** A confidence in `[0, 1]`, as the decision model gives one. */
const Confidence = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));

it.effect.prop(
  "a model answer replaces the planner's model only at or above judge.minProbability",
  [Confidence],
  ([confidence]) =>
    Effect.gen(function* () {
      const result = yield* refineWith(
        Struct.evolve(base, {
          drafts: () => [Struct.evolve(draft("Refine"), { model: () => "opus" })],
        }),
        defaults,
      );
      const confident = Number.isGreaterThanOrEqualTo(confidence, defaults.judge.minProbability);
      const model = Array.findFirst(result.judgments, (judgment) => judgment.question === "model");
      expect(Array.map(result.drafts, Struct.get("model"))).toEqual([confident ? "haiku" : "opus"]);
      expect(Option.map(model, Struct.pick(["action", "verdict"]))).toEqual(
        Option.some(
          confident ? { action: "routed", verdict: "pass" } : { action: "none", verdict: "unsure" },
        ),
      );
      expect(
        Option.exists(model, (judgment) =>
          String.includes("routed opus to haiku")(judgment.message),
        ),
      ).toBe(confident);
    }).pipe(
      Effect.provide(
        testing({
          answer: (_, question) =>
            question === "model" ? Option.some({ confidence, label: "haiku" }) : Option.none(),
        }),
      ),
    ),
  { arbitrary: { runs: 30 } },
);

it.effect(
  "a confident reasoning answer routes the draft and an unsure one keeps the planner's",
  () =>
    Effect.gen(function* () {
      const result = yield* refineWith(
        Struct.evolve(base, { drafts: () => [draft("Refine"), draft("Plan")] }),
        defaults,
      );
      expect(Array.map(result.drafts, (each) => [each.title, each.model, each.reasoning])).toEqual([
        ["Refine", "sonnet", "low"],
        ["Plan", "sonnet", "high"],
      ]);
      expect(
        Array.filterMap(result.judgments, (judgment) =>
          judgment.action === "routed" ? Result.succeed(judgment.message) : Result.failVoid,
        ),
      ).toEqual(["reasoning low, 0.9; routed high to low"]);
    }).pipe(
      Effect.provide(
        testing({
          answer: (title, question) =>
            question === "reasoning" && title === "Refine"
              ? Option.some({ confidence: 0.9, label: "low" })
              : Option.none(),
        }),
      ),
    ),
);

it.effect(
  "a confidently too_large section is split into sections with IDs, which are judged again",
  () =>
    Effect.gen(function* () {
      const result = yield* refineWith(
        Struct.evolve(base, { specGenerated: () => true }),
        defaults,
      );
      expect(sectionIdsOf(result.spec)).toEqual([
        "spec.judging",
        "spec.judging.checkpoints-a",
        "spec.judging.checkpoints-b",
        "spec.judging.verdicts",
      ]);
      const split = sizeOf(result.judgments, "section", "spec.judging.checkpoints");
      expect(Option.map(split, Struct.pick(["action", "message", "round"]))).toEqual(
        Option.some({
          action: "split",
          message:
            "size is too_large, 0.9; split into spec.judging.checkpoints-a, spec.judging.checkpoints-b",
          round: 1,
        }),
      );
      expect(
        Array.map(
          [
            "spec.judging",
            "spec.judging.verdicts",
            "spec.judging.checkpoints-a",
            "spec.judging.checkpoints-b",
          ],
          (id) => Option.map(sizeOf(result.judgments, "section", id), Struct.get("round")),
        ),
      ).toEqual([Option.some(1), Option.some(1), Option.some(2), Option.some(2)]);
      // The replacements keep the keys they inherit and the ones they list.
      const replacements = Array.filter(sectionsOf(result.spec), (section) =>
        String.startsWith("Checkpoints ")(section.title),
      );
      expect(Array.map(replacements, (section) => section.keys.implements)).toEqual([
        ["prd.judging-the-plan", "prd.cli"],
        ["prd.judging-the-plan", "prd.cli"],
      ]);
    }).pipe(
      Effect.provide(
        testing({
          answer: tooLarge((title) => title === "Checkpoints"),
          splitSection: sectionHalves,
        }),
      ),
    ),
);

it.effect("a section split that drops an Implements is discarded and the spec kept", () =>
  Effect.gen(function* () {
    const result = yield* refineWith(Struct.evolve(base, { specGenerated: () => true }), defaults);
    expect(result.spec).toBe(SPEC);
    const size = sizeOf(result.judgments, "section", "spec.judging.checkpoints");
    expect(Option.map(size, Struct.pick(["action", "message", "verdict"]))).toEqual(
      Option.some({
        action: "none",
        message:
          "size is too_large, 0.9; the split was discarded: spec.judging.tasks drops Implements prd.cli",
        verdict: "flag",
      }),
    );
  }).pipe(
    Effect.provide(
      testing({
        answer: tooLarge((title) => title === "Checkpoints"),
        splitSection: () =>
          "### Sections {#spec.judging.sections}\n\n- Implements: `prd.cli`\n\nThe sections.\n\n### Tasks {#spec.judging.tasks}\n\n- Files: `packages/cli/src/refine.ts`\n\nThe tasks.",
      }),
    ),
  ),
);

it.effect(
  "a flagged inScope is reported with the section's and the draft's other answers and changes nothing",
  () =>
    Effect.gen(function* () {
      const given = Struct.evolve(base, {
        drafts: () => [draft("Refine")],
        specGenerated: () => true,
      });
      const result = yield* refineWith(given, defaults);
      const scope = Array.filter(result.judgments, (judgment) => judgment.question === "inScope");
      const kinds = Array.dedupe(Array.map(scope, (judgment) => judgment.target.kind));
      expect(Array.sort(kinds, Order.String)).toEqual(["draft", "section"]);
      expect(Array.every(scope, (judgment) => judgment.verdict === "flag")).toBe(true);
      expect(Array.every(scope, (judgment) => judgment.action === "none")).toBe(true);
      // Each target that was asked inScope was asked its other probability too.
      const questionsOf = (kind: "draft" | "section") =>
        Array.sort(
          Array.dedupe(
            Array.filterMap(result.judgments, (judgment) =>
              judgment.target.kind === kind &&
              (judgment.question === "faithful" ||
                judgment.question === "matches" ||
                judgment.question === "inScope")
                ? Result.succeed(judgment.question)
                : Result.failVoid,
            ),
          ),
          Order.String,
        );
      expect(questionsOf("section")).toEqual(["faithful", "inScope"]);
      expect(questionsOf("draft")).toEqual(["inScope", "matches"]);
      expect([result.spec, result.drafts]).toEqual([given.spec, given.drafts]);
      const splits = [yield* sectionSplitsOf, yield* taskSplitsOf];
      expect(splits).toEqual([[], []]);
    }).pipe(
      Effect.provide(
        testing({
          probability: (_, question) => (question === "inScope" ? Option.some(0) : Option.none()),
        }),
      ),
    ),
);

it.effect.prop(
  "a confident category is reported against the draft's and never changes it",
  [Schema.Literals(Array.map(defaults.categories, Struct.get("name")))],
  ([label]) =>
    Effect.gen(function* () {
      const given = Struct.evolve(base, { drafts: () => [draft("Refine")] });
      const result = yield* refineWith(given, defaults);
      const reported = Array.filter(result.judgments, (j) => j.question === "category");
      expect(Array.map(reported, (j) => [j.target.kind, j.action])).toEqual([["draft", "none"]]);
      expect(Array.map(reported, (j) => j.verdict)).toEqual([
        label === "feature" ? "pass" : "flag",
      ]);
      if (label !== "feature") {
        expect(Array.map(reported, (j) => j.message)).toEqual([
          expect.stringContaining(`category ${label} differs from the manifest's feature`),
        ]);
      }
      expect(result.drafts).toEqual(given.drafts);
      expect(Array.map(result.drafts, (each) => each.category)).toEqual(["feature"]);
    }).pipe(
      Effect.provide(
        testing({
          answer: (_, question) =>
            question === "category" ? Option.some({ confidence: 0.9, label }) : Option.none(),
        }),
      ),
    ),
);

it.effect(
  "a draft a split replaces keeps its category verdict against the draft's own category",
  () =>
    Effect.gen(function* () {
      const given = Struct.evolve(base, { drafts: () => [draft("Refine")] });
      const result = yield* refineWith(given, defaults);
      const original = Array.filter(
        result.judgments,
        (j) =>
          j.question === "category" && j.target.kind === "draft" && j.target.title === "Refine",
      );
      expect(Array.map(original, (j) => j.verdict)).toEqual(["flag"]);
      expect(Array.map(original, (j) => j.message)).toEqual([expect.stringContaining("feature")]);
      expect(Array.map(result.drafts, (each) => each.title)).toEqual(["Refine a", "Refine b"]);
    }).pipe(
      Effect.provide(
        testing({
          answer: (title, question) =>
            question === "category"
              ? Option.some({ confidence: 0.9, label: "ui" })
              : tooLarge((asked) => asked === "Refine")(title, question),
          splitTask: halves,
        }),
      ),
    ),
);

it.effect("an unsure category is reported as unsure and the draft keeps its category", () =>
  Effect.gen(function* () {
    const given = Struct.evolve(base, { drafts: () => [draft("Refine")] });
    const result = yield* refineWith(given, defaults);
    expect(
      Array.map(
        Array.filter(result.judgments, (j) => j.question === "category"),
        (j) => j.verdict,
      ),
    ).toEqual(["unsure"]);
    expect(result.drafts).toEqual(given.drafts);
  }).pipe(Effect.provide(testing({}))),
);

it.effect("a section a person wrote is reported on and never split", () =>
  Effect.gen(function* () {
    const spec = pipe(
      SPEC,
      String.replace(
        "Refine the spec and drafts.",
        "<!-- human -->\n\nRefine the spec and drafts.",
      ),
    );
    const result = yield* refineWith(
      Struct.evolve(base, { spec: () => spec, specGenerated: () => true }),
      defaults,
    );
    const splits = yield* sectionSplitsOf;
    expect([splits, result.spec]).toEqual([[], spec]);
    expect(
      Option.map(
        sizeOf(result.judgments, "section", "spec.judging.checkpoints"),
        Struct.get("message"),
      ),
    ).toEqual(Option.some("size is too_large, 0.9; not split: a person wrote or edited it"));
  }).pipe(
    Effect.provide(
      testing({
        answer: tooLarge((title) => title === "Checkpoints"),
        splitSection: sectionHalves,
      }),
    ),
  ),
);

it.effect.prop(
  "when the spec was not generated, only the sections written in this run are judged",
  [
    Schema.Array(
      Schema.Literals(["spec.judging", "spec.judging.checkpoints", "spec.judging.verdicts"]),
    ),
  ],
  ([written]) =>
    Effect.gen(function* () {
      const result = yield* refineWith(
        Struct.evolve(base, { written: () => Array.map(written, specId) }),
        defaults,
      );
      const decided = yield* decidedOf;
      const judged = Array.dedupe(
        Array.filterMap(result.judgments, (judgment) =>
          judgment.target.kind === "section" ? Result.succeed(judgment.target.id) : Result.failVoid,
        ),
      );
      expect(Array.sort(judged, Order.String)).toEqual(
        Array.sort(Array.dedupe(written), Order.String),
      );
      // One request per section, and the placeholder stack once when anything is judged.
      expect(Array.length(decided)).toBe(
        Array.isReadonlyArrayNonEmpty(written) ? Array.length(Array.dedupe(written)) + 1 : 0,
      );
    }).pipe(Effect.provide(testing({}))),
  { arbitrary: { runs: 30 } },
);

it.effect("without TYPESAFE_API_KEY refine returns its input unchanged with no judgments", () =>
  Effect.gen(function* () {
    const given = Struct.evolve(base, {
      drafts: () => [draft("Refine")],
      specGenerated: () => true,
    });
    const result = yield* refine(given, defaults);
    const splits = yield* taskSplitsOf;
    expect(result).toEqual({ drafts: given.drafts, judgments: [], spec: given.spec });
    expect(splits).toEqual([]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        scripted({ answer: tooLarge(), splitTask: halves }),
        ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
      ),
    ),
  ),
);

it.effect.prop(
  "the refined drafts keep every spec section and file of the drafts given, whatever a split returns",
  [
    Schema.Array(TaskDraft).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
    Schema.Boolean,
    Schema.Boolean,
  ],
  ([generated, dropSection, dropFile]) =>
    Effect.gen(function* () {
      const drafts = Array.dedupeWith(generated, (a, b) => a.title === b.title);
      const result = yield* refineWith(Struct.evolve(base, { drafts: () => drafts }), defaults);
      const splits = yield* taskSplitsOf;
      const kept = (field: (each: TaskDraft) => ReadonlyArray<string>) =>
        Array.every(Array.flatMap(drafts, field), (item) =>
          Array.some(result.drafts, (each) => Array.contains(field(each), item)),
        );
      expect([kept(Struct.get("specSections")), kept(Struct.get("files"))]).toEqual([true, true]);
      expect(Array.length(splits)).toBe(Array.length(drafts));
    }).pipe(
      Effect.provide(
        testing({
          answer: tooLarge(),
          splitTask: (whole) =>
            Array.map(["a", "b"], (suffix) =>
              Struct.evolve(whole, {
                files: (files) => (dropFile ? Array.drop(files, 1) : files),
                specSections: (ids) =>
                  dropSection
                    ? Array.prepend(Array.tailNonEmpty(ids), specId("spec.unrelated"))
                    : ids,
                title: (title) => `${title} ${suffix}`,
              }),
            ),
        }),
      ),
    ),
  { arbitrary: { runs: 30 } },
);

it.effect("a draft that names a split section names its replacements instead", () =>
  Effect.gen(function* () {
    const result = yield* refineWith(
      Struct.evolve(base, { drafts: () => [draft("Refine")], specGenerated: () => true }),
      defaults,
    );
    expect(Array.map(result.drafts, Struct.get("specSections"))).toEqual([
      ["spec.judging.checkpoints-a", "spec.judging.checkpoints-b", "spec.judging.verdicts"],
    ]);
  }).pipe(
    Effect.provide(
      testing({
        answer: tooLarge((title) => title === "Checkpoints"),
        splitSection: sectionHalves,
      }),
    ),
  ),
);

it.effect("drafts split in the same round depend on each other's replacements", () =>
  Effect.gen(function* () {
    const result = yield* refineWith(
      Struct.evolve(base, {
        drafts: () => [
          draft("Store"),
          Struct.evolve(draft("Serve"), { dependsOn: () => ["Store"] }),
          Struct.evolve(draft("Show"), { dependsOn: () => ["Serve", "Store"] }),
        ],
      }),
      defaults,
    );
    expect(Array.map(result.drafts, (each) => [each.title, each.dependsOn])).toEqual([
      ["Store a", []],
      ["Store b", ["Store a"]],
      ["Serve a", ["Store a", "Store b"]],
      ["Serve b", ["Serve a"]],
      ["Show", ["Serve a", "Serve b", "Store a", "Store b"]],
    ]);
  }).pipe(
    Effect.provide(
      testing({
        answer: tooLarge((title) => title === "Store" || title === "Serve"),
        splitTask: (whole) =>
          Array.map(halves(whole), (half) =>
            String.endsWith(" a")(half.title)
              ? Struct.evolve(half, { dependsOn: () => whole.dependsOn })
              : half,
          ),
      }),
    ),
  ),
);
