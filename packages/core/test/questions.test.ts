import { Manifest, Reasoning, Slug } from "@cairn/contract";
import { describe, expect, it } from "@effect/vitest";
import { Array, Match, Option, Record, Schema, String, Struct, pipe } from "effect";
import type { Decision } from "effect/ai";

import {
  SectionJudgingInput,
  StackJudgingInput,
  TaskJudgingInput,
  declarationsOf,
  inputsOf,
  separableInputOf,
  sectionQuestions,
  stackQuestions,
  taskQuestions,
  taskQuestionsWithoutModel,
} from "../src/index.ts";

const PRD = Array.join(
  [
    "# Billing {#prd.billing}",
    "",
    "Bill customers.",
    "",
    "## Goal {#prd.goal}",
    "",
    "Charge every customer once a month.",
    "",
    "## Charges {#prd.charges}",
    "",
    "Charge a card.",
    "",
    "## Refunds {#prd.refunds}",
    "",
    "Refund a charge.",
    "",
    "## Later",
    "",
  ],
  "\n",
);

const SPEC = Array.join(
  [
    "# Spec {#spec.spec}",
    "",
    "- Context: `prd.goal`",
    "",
    "## Store {#spec.store}",
    "",
    "- Implements: `prd.charges`",
    "- Files: `src/store.ts`",
    "",
    "Keep each charge.",
    "",
    "### Index {#spec.store.index}",
    "",
    "Find a charge by card.",
    "",
    "## Charge {#spec.charge}",
    "",
    "- Implements: `prd.charges`, `prd.refunds`, `prd.missing`",
    "- Files: `src/charge.ts`, `src/refund.ts`",
    "",
    "Charge and refund.",
    "",
    "## Notes {#spec.notes}",
    "",
    "No files here.",
    "",
    "## Unnamed",
    "",
    "- Files: `src/unnamed.ts`",
    "",
  ],
  "\n",
);

const SPEC_IDS = [
  "spec.store",
  "spec.store.index",
  "spec.charge",
  "spec.notes",
  "spec.gone",
] as const;
const PRD_IDS = ["prd.goal", "prd.charges", "prd.refunds", "prd.gone"] as const;

/**
 * Tasks as a plan might hold them. Task `i` is `t<i>`; it depends on the tasks in `needs`, which
 * may name one the manifest does not have, and links spec and PRD sections that may not exist.
 */
const Tasks = Schema.Array(
  Schema.Struct({
    files: Schema.Array(Schema.String).check(Schema.isMaxLength(3)),
    model: Schema.NonEmptyString,
    needs: Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 }))).check(
      Schema.isMaxLength(3),
    ),
    prd: Schema.Array(Schema.Literals(PRD_IDS)).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
    reasoning: Reasoning,
    spec: Schema.Array(Schema.Literals(SPEC_IDS)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(3),
    ),
    title: Schema.NonEmptyString,
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(8));
type Tasks = typeof Tasks.Type;

const decodeManifest = Schema.decodeUnknownSync(Manifest);
const feature = Schema.decodeSync(Slug)("billing");

const manifestOf = (tasks: Tasks): Manifest =>
  decodeManifest({
    baseBranch: "main",
    feature,
    tasks: Array.map(tasks, (task, index) => ({
      branch: `billing/${index + 10}-task`,
      commits: [],
      dependsOn: Array.map(task.needs, (need) => `t${need}`),
      files: task.files,
      humanGate: { reasons: [], required: false },
      id: `t${index}`,
      model: task.model,
      parent: null,
      prdSections: task.prd,
      reasoning: task.reasoning,
      sessions: [],
      specSections: task.spec,
      status: "pending",
      title: task.title,
      worktree: null,
    })),
    version: 1,
  });

/** Encodes as `DecisionModel.decide` encodes an input before it calls the provider. */
const encodeJson = (schema: Schema.Top & { readonly EncodingServices: never }) =>
  Schema.encodeUnknownSync(Schema.toCodecJson(schema));

describe("inputsOf", () => {
  const one = manifestOf([
    {
      files: ["src/store.ts"],
      model: "sonnet",
      needs: [],
      prd: ["prd.charges"],
      reasoning: "medium",
      spec: ["spec.store"],
      title: "Add the store",
    },
    {
      files: ["src/charge.ts"],
      model: "opus",
      needs: [0, 7],
      prd: ["prd.charges", "prd.gone"],
      reasoning: "high",
      spec: ["spec.charge", "spec.gone"],
      title: "Charge cards",
    },
  ]);
  const inputs = inputsOf(PRD, SPEC, one);

  it("asks about each spec section that has an ID, with the PRD sections it implements", () => {
    expect(Array.map(inputs.sections, ({ id }) => id)).toEqual([
      "spec.spec",
      "spec.store",
      "spec.store.index",
      "spec.charge",
      "spec.notes",
    ]);
    const charge = Array.findFirst(inputs.sections, ({ id }) => id === "spec.charge");
    expect(
      Option.map(charge, ({ input }) => Struct.pick(input, ["files", "implements", "title"])),
    ).toEqual(
      Option.some({
        files: ["src/charge.ts", "src/refund.ts"],
        implements: [
          { body: "\nCharge a card.\n", title: "Charges" },
          { body: "\nRefund a charge.\n", title: "Refunds" },
        ],
        title: "Charge",
      }),
    );
    expect(Option.map(charge, ({ input }) => input.body)).toEqual(
      Option.some(
        "\n- Implements: `prd.charges`, `prd.refunds`, `prd.missing`\n- Files: `src/charge.ts`, `src/refund.ts`\n\nCharge and refund.\n",
      ),
    );
  });

  it("gives a task the titles it depends on and the text of its sections, and leaves out what is missing", () => {
    expect(Array.map(inputs.tasks, ({ id }) => id)).toEqual(["t0", "t1"]);
    expect(Option.map(Array.get(inputs.tasks, 1), ({ input }) => input)).toEqual(
      Option.some({
        dependsOn: ["Add the store"],
        files: ["src/charge.ts"],
        prdSections: [{ body: "\nCharge a card.\n", title: "Charges" }],
        specSections: [
          {
            body: "\n- Implements: `prd.charges`, `prd.refunds`, `prd.missing`\n- Files: `src/charge.ts`, `src/refund.ts`\n\nCharge and refund.\n",
            title: "Charge",
          },
        ],
        title: "Charge cards",
      }),
    );
  });

  it("gives the stack the feature, the goal, every PRD section with an ID and every task", () => {
    expect(inputs.stack).toEqual({
      feature: "billing",
      goal: "\nCharge every customer once a month.\n",
      prdSections: [
        { id: "prd.billing", title: "Billing" },
        { id: "prd.goal", title: "Goal" },
        { id: "prd.charges", title: "Charges" },
        { id: "prd.refunds", title: "Refunds" },
      ],
      tasks: [
        {
          dependsOn: [],
          id: "t0",
          prdSections: ["prd.charges"],
          specSections: ["spec.store"],
          title: "Add the store",
        },
        {
          dependsOn: ["t0", "t7"],
          id: "t1",
          prdSections: ["prd.charges", "prd.gone"],
          specSections: ["spec.charge", "spec.gone"],
          title: "Charge cards",
        },
      ],
    });
  });

  it("takes the goal from the first heading when the PRD has no prd.goal", () => {
    const prd = "# Billing {#prd.billing}\n\nBill customers.\n\n## Charges {#prd.charges}\n";
    expect(inputsOf(prd, SPEC, one).stack.goal).toBe("\nBill customers.\n");
  });

  it.prop(
    "a task's input leaves out the planner's model and reasoning",
    [Tasks, Schema.NonEmptyString, Reasoning],
    ([tasks, model, reasoning]) => {
      const routed = Array.map(tasks, Struct.assign({ model, reasoning }));
      expect(inputsOf(PRD, SPEC, manifestOf(routed))).toEqual(
        inputsOf(PRD, SPEC, manifestOf(tasks)),
      );
    },
  );

  it.prop(
    "one input per task, in manifest order, naming the titles of the tasks it depends on",
    [Tasks],
    ([tasks]) => {
      const manifest = manifestOf(tasks);
      const { stack, tasks: taskInputs } = inputsOf(PRD, SPEC, manifest);
      expect(Array.map(taskInputs, ({ id }) => id)).toEqual(
        Array.map(manifest.tasks, ({ id }) => id),
      );
      Array.forEach(Array.zip(taskInputs, manifest.tasks), ([{ input }, task]) => {
        expect(input.title).toBe(task.title);
        expect(input.files).toEqual(task.files);
        expect(input.dependsOn).toEqual(
          Array.getSomes(
            Array.map(task.dependsOn, (id) =>
              pipe(
                Array.findFirst(manifest.tasks, (other) => other.id === id),
                Option.map(({ title }) => title),
              ),
            ),
          ),
        );
      });
      expect(Array.map(stack.tasks, ({ id }) => id)).toEqual(
        Array.map(manifest.tasks, ({ id }) => id),
      );
    },
  );

  it.prop("every input encodes with its definition's input schema", [Tasks], ([tasks]) => {
    const { sections, stack, tasks: taskInputs } = inputsOf(PRD, SPEC, manifestOf(tasks));
    Array.forEach(sections, ({ input }) => {
      expect(() => encodeJson(sectionQuestions.input)(input)).not.toThrow();
    });
    Array.forEach(taskInputs, ({ input }) => {
      expect(() => encodeJson(TaskJudgingInput)(input)).not.toThrow();
    });
    expect(() => encodeJson(stackQuestions.input)(stack)).not.toThrow();
    expect(sectionQuestions.input).toBe(SectionJudgingInput);
    expect(stackQuestions.input).toBe(StackJudgingInput);
    expect(taskQuestions({ haiku: "small", opus: "large" }).input).toBe(TaskJudgingInput);
  });
});

/** A decision's kind, and its labels in order for a rating or a classification. */
const shapeOf = (decision: Decision.Any): readonly [string, ReadonlyArray<string>] =>
  Match.valueTags(decision, {
    Classify: ({ criteria }) => ["classify", Record.keys(criteria)] as const,
    Locate: () => ["locate", []] as const,
    Probability: () => ["probability", []] as const,
    Rate: ({ criteria }) => ["rate", Array.map(criteria, ({ label }) => label)] as const,
  });

/**
 * The descriptions a rating or a probability gives the provider for its levels or outcomes. A
 * classification's descriptions come from config, so it has none of its own.
 */
const descriptionsOf = (decision: Decision.Any): ReadonlyArray<unknown> =>
  Match.valueTags(decision, {
    Classify: () => [],
    Locate: () => [],
    Probability: ({ criteria }) =>
      Option.match(Option.fromUndefinedOr(criteria), {
        onNone: () => [undefined],
        onSome: (outcomes) => [outcomes.false, outcomes.true],
      }),
    Rate: ({ criteria }) => Array.map(criteria, ({ description }) => description),
  });

const SIZE = ["too_small", "right", "too_large"];
const models = { haiku: "Mechanical changes", opus: "Subtle logic", sonnet: "Most tasks" };

describe("the questions", () => {
  it("asks each target what the spec's table lists, of the kind it lists", () => {
    expect(Record.map(sectionQuestions.decisions, shapeOf)).toEqual({
      buildable: ["probability", []],
      faithful: ["probability", []],
      size: ["rate", SIZE],
    });
    expect(Record.map(taskQuestions(models).decisions, shapeOf)).toEqual({
      matches: ["probability", []],
      model: ["classify", ["haiku", "opus", "sonnet"]],
      reasoning: ["rate", Reasoning.literals],
      size: ["rate", SIZE],
    });
    expect(Record.map(stackQuestions.decisions, shapeOf)).toEqual({
      complete: ["probability", []],
      oneFeature: ["probability", []],
      ordered: ["probability", []],
    });
  });

  it.prop(
    "the model question chooses between the names in judge.models, with each one's description",
    [Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(6))],
    ([descriptions]) => {
      const named = Record.fromEntries(
        Array.map(descriptions, (description, index) => [`model-${index}`, description] as const),
      );
      const question = taskQuestions(named).decisions.model;
      expect(question.criteria).toEqual(named);
    },
  );

  it.prop(
    "the questions without model are the task questions minus model, on the same input",
    [Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(6))],
    ([descriptions]) => {
      const named = Record.fromEntries(
        Array.map(descriptions, (description, index) => [`model-${index}`, description] as const),
      );
      const withModel = taskQuestions(named);
      expect(taskQuestionsWithoutModel.decisions).toEqual(
        Struct.omit(withModel.decisions, ["model"]),
      );
      expect(taskQuestionsWithoutModel.input).toBe(withModel.input);
    },
  );

  it("describes every rating level and probability with an example", () => {
    const decisions = Array.flatMap(
      [sectionQuestions.decisions, taskQuestions(models).decisions, stackQuestions.decisions],
      (all) => Record.values<string, Decision.Any>(all),
    );
    const described = Array.flatMap(decisions, descriptionsOf);
    expect(Array.length(described)).toBe(23);
    Array.forEach(described, (description) => {
      expect(description).toSatisfy(
        (text: unknown) => Schema.is(Schema.String)(text) && String.includes("Example: ")(text),
      );
    });
  });
});

describe("separableInputOf", () => {
  const SOURCE = Array.join(
    [
      'import { Array } from "effect";',
      "",
      "export const historyOf = (commits) => commits;",
      "const pairKey = (a, b) => a + b;",
      "export interface Score {",
      "  readonly score: number;",
      "}",
      "  const nested = 1;",
      "export function* walk() {}",
      "export const historyOf = 2;",
    ],
    "\n",
  );

  it("reads the top-level declarations of a file, each once, and none that are nested", () => {
    expect(declarationsOf(SOURCE)).toEqual(["historyOf", "pairKey", "Score", "walk"]);
  });

  it("gives each section the declarations its body names as words", () => {
    expect(
      separableInputOf("src/conflicts.ts", declarationsOf(SOURCE), [
        {
          sections: [
            {
              body: "`historyOf(commits)` counts changes; a Scored pair is not Score.",
              summary: "History",
            },
          ],
          title: "Count history",
        },
        { sections: [{ body: "Nothing here.", summary: "Other" }], title: "Other work" },
      ]),
    ).toEqual({
      declarations: ["historyOf", "pairKey", "Score", "walk"],
      path: "src/conflicts.ts",
      tasks: [
        {
          sections: [{ declarations: ["historyOf", "Score"], summary: "History" }],
          title: "Count history",
        },
        { sections: [{ declarations: [], summary: "Other" }], title: "Other work" },
      ],
    });
  });
});
