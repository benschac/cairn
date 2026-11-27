import { Config, JudgmentQuestion, Manifest, PrdSectionId, Reasoning, Slug } from "@cairn/contract";
import { describe, expect, it } from "@effect/vitest";
import { Array, Match, Number, Option, Order, Record, Schema, String, Struct, pipe } from "effect";
import type { Decision } from "effect/ai";

import {
  MAX_OTHERS,
  sectionsOf,
  PrdSectionJudgingInput,
  SectionJudgingInput,
  StackJudgingInput,
  TaskJudgingInput,
  inputsOf,
  prdSectionQuestions,
  prdSectionsBuiltBy,
  sectionQuestions,
  stackQuestions,
  taskQuestions,
  taskQuestionsFor,
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
        others: [],
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
    const {
      prdSections,
      sections,
      stack,
      tasks: taskInputs,
    } = inputsOf(PRD, SPEC, manifestOf(tasks));
    Array.forEach(prdSections, ({ input }) => {
      expect(() => encodeJson(prdSectionQuestions.input)(input)).not.toThrow();
    });
    expect(prdSectionQuestions.input).toBe(PrdSectionJudgingInput);
    Array.forEach(sections, ({ input }) => {
      expect(() => encodeJson(sectionQuestions.input)(input)).not.toThrow();
    });
    Array.forEach(taskInputs, ({ input }) => {
      expect(() => encodeJson(TaskJudgingInput)(input)).not.toThrow();
    });
    expect(() => encodeJson(stackQuestions.input)(stack)).not.toThrow();
    expect(sectionQuestions.input).toBe(SectionJudgingInput);
    expect(stackQuestions.input).toBe(StackJudgingInput);
    expect(taskQuestions({ haiku: "small", opus: "large" }, categories).input).toBe(
      TaskJudgingInput,
    );
  });
});

/** `tasks` with each title naming its index, so a task's `others` can be read back as IDs. */
const titled = (tasks: Tasks): Tasks =>
  Array.map(tasks, (task, index) => Struct.evolve(task, { title: () => `Task ${index}` }));

/** The task ID a title from `titled` names. */
const idOfTitle = (title: string) => `t${String.replace("Task ", "")(title)}`;

/** Each spec section's `Implements`, inherited ones included, by its ID. */
const specImplements: Record.ReadonlyRecord<string, ReadonlyArray<string>> = Record.fromEntries(
  Array.getSomes(
    Array.map(sectionsOf(SPEC), (section) =>
      Option.map(
        Option.fromUndefinedOr(section.id),
        (id): readonly [string, ReadonlyArray<string>] => [id, section.keys.implements],
      ),
    ),
  ),
);

/** The PRD IDs a task names or reaches through the spec sections it builds. */
const implementedBy = (task: Manifest["tasks"][number]): ReadonlyArray<string> =>
  Array.appendAll<string, string>(
    task.prdSections,
    Array.flatMap(task.specSections, (id) =>
      Option.getOrElse(Record.get(specImplements, id), (): ReadonlyArray<string> => []),
    ),
  );

const PRD_HEADINGS = ["prd.billing", "prd.goal", "prd.charges", "prd.refunds"];

/** Every task reached from `start` by `edges`, one step at a time, at most one step per task. */
const closureOf = (
  edges: (id: string) => ReadonlyArray<string>,
  start: string,
  steps: number,
): ReadonlyArray<string> =>
  Array.reduce(
    Array.makeBy(steps, () => 0),
    Array.dedupe(edges(start)),
    (reached) => Array.dedupe(Array.appendAll(reached, Array.flatMap(reached, edges))),
  );

describe("PRD section inputs", () => {
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
      needs: [0],
      prd: ["prd.goal"],
      reasoning: "high",
      spec: ["spec.charge", "spec.gone"],
      title: "Charge cards",
    },
  ]);

  it("gives a PRD section its title, body and each task that implements it, with that task's spec section titles", () => {
    expect(inputsOf(PRD, SPEC, one).prdSections).toEqual([
      {
        id: "prd.goal",
        input: {
          body: "\nCharge every customer once a month.\n",
          tasks: [{ files: ["src/charge.ts"], specSections: ["Charge"], title: "Charge cards" }],
          title: "Goal",
        },
      },
      {
        id: "prd.charges",
        input: {
          body: "\nCharge a card.\n",
          tasks: [
            { files: ["src/store.ts"], specSections: ["Store"], title: "Add the store" },
            { files: ["src/charge.ts"], specSections: ["Charge"], title: "Charge cards" },
          ],
          title: "Charges",
        },
      },
      {
        id: "prd.refunds",
        input: {
          body: "\nRefund a charge.\n",
          tasks: [{ files: ["src/charge.ts"], specSections: ["Charge"], title: "Charge cards" }],
          title: "Refunds",
        },
      },
    ]);
  });

  it("counts a task that names a list item as implementing the section the item is under", () => {
    const prd = String.replace(
      "Refund a charge.\n",
      "Refund a charge.\n\n- Refund part of a charge. {#prd.refunds.partial}\n",
    )(PRD);
    // A task that names only the item, and builds a spec section that implements nothing.
    const itemOnly = Struct.evolve(
      manifestOf([
        {
          files: ["src/partial.ts"],
          model: "sonnet",
          needs: [],
          prd: ["prd.gone"],
          reasoning: "medium",
          spec: ["spec.notes"],
          title: "Refund part of a charge",
        },
      ]),
      {
        tasks: Array.map((task) =>
          Struct.evolve(task, {
            prdSections: () => Array.make(PrdSectionId.make("prd.refunds.partial")),
          }),
        ),
      },
    );
    expect(Array.map(inputsOf(prd, SPEC, itemOnly).prdSections, Struct.get("id"))).toEqual([
      "prd.refunds",
    ]);
    expect(prdSectionsBuiltBy(prd, SPEC, itemOnly.tasks)).toEqual(["prd.refunds"]);
  });

  it.prop(
    "one input per PRD section that some task implements, in document order, with only those tasks",
    [Tasks],
    ([tasks]) => {
      const manifest = manifestOf(tasks);
      const buildersOf = (id: string) =>
        Array.filter(manifest.tasks, (task) => Array.contains(implementedBy(task), id));
      const expected = Array.filter(PRD_HEADINGS, (id) =>
        Array.isReadonlyArrayNonEmpty(buildersOf(id)),
      );
      const { prdSections } = inputsOf(PRD, SPEC, manifest);
      expect(Array.map(prdSections, Struct.get("id"))).toEqual(expected);
      expect(prdSectionsBuiltBy(PRD, SPEC, manifest.tasks)).toEqual(expected);
      Array.forEach(prdSections, ({ id, input }) => {
        expect(Array.map(input.tasks, Struct.get("title"))).toEqual(
          Array.map(buildersOf(id), Struct.get("title")),
        );
      });
    },
  );
});

/** Whether two tasks share a spec section, a PRD section or a file. */
const shares = (a: Manifest["tasks"][number], b: Manifest["tasks"][number]) =>
  Array.some(a.specSections, (id) => Array.contains(b.specSections, id)) ||
  Array.some(a.prdSections, (id) => Array.contains(b.prdSections, id)) ||
  Array.some(a.files, (file) => Array.contains(b.files, file));

/** A task with one shared file and the sections given. */
const shaped = (
  spec: Tasks[number]["spec"],
  prd: Tasks[number]["prd"],
  needs: Tasks[number]["needs"] = [],
): Tasks[number] => ({
  files: ["src/shared.ts"],
  model: "sonnet",
  needs,
  prd,
  reasoning: "medium",
  spec,
  title: "",
});

describe("a task's others", () => {
  it.prop(
    "never hold the task or a task it depends on, directly or not, and hold every other task it shares a section or file with, up to the cap",
    [Tasks],
    ([tasks]) => {
      const manifest = manifestOf(titled(tasks));
      const steps = Array.length(manifest.tasks);
      const dependsOn = (id: string): ReadonlyArray<string> =>
        Option.match(
          Array.findFirst(manifest.tasks, (task) => task.id === id),
          { onNone: () => [], onSome: (task) => task.dependsOn },
        );
      const { tasks: inputs } = inputsOf(PRD, SPEC, manifest);
      Array.forEach(Array.zip(inputs, manifest.tasks), ([{ input }, task]) => {
        const near = closureOf(dependsOn, task.id, steps);
        const expected = Array.filter(
          manifest.tasks,
          (other) =>
            other.id !== task.id && !Array.contains<string>(near, other.id) && shares(task, other),
        );
        const others = Array.map(input.others, ({ title }) => idOfTitle(title));
        expect(Array.length(others)).toBe(Number.min(Array.length(expected), MAX_OTHERS));
        expect(
          Array.every(others, (id) => !Array.contains<string>(near, id) && id !== task.id),
        ).toBe(true);
        expect(Array.sort(others, Order.String)).toEqual(
          Array.sort(Array.map(expected, Struct.get("id")), Order.String),
        );
        Array.forEach(input.others, (other) => {
          expect(other.files).toEqual(
            Option.getOrThrow(
              Array.findFirst(manifest.tasks, (each) => each.id === idOfTitle(other.title)),
            ).files,
          );
        });
      });
    },
  );

  it("holds at most ten, those sharing the most first, then in manifest order", () => {
    const manifest = manifestOf(
      titled(
        Array.flatten([
          [shaped(["spec.store"], ["prd.charges"])],
          Array.makeBy(11, () => shaped(["spec.notes"], ["prd.goal"])),
          Array.makeBy(3, () => shaped(["spec.store"], ["prd.goal"])),
          [shaped(["spec.store"], ["prd.charges"], [0])],
        ]),
      ),
    );
    const first = Option.getOrThrow(Array.head(inputsOf(PRD, SPEC, manifest).tasks));
    // t15 depends on t0 and shares the most with it, so it comes first.
    expect(Array.map(first.input.others, ({ title }) => idOfTitle(title))).toEqual([
      "t15",
      "t12",
      "t13",
      "t14",
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
    ]);
    expect(MAX_OTHERS).toBe(10);
  });

  it("holds a task that depends on it, and never a task it depends on, directly or not", () => {
    // t1 needs t0 and t2 needs t1; all three share a file.
    const manifest = manifestOf(
      titled([
        shaped(["spec.store"], ["prd.charges"]),
        shaped(["spec.store"], ["prd.charges"], [0]),
        shaped(["spec.notes"], ["prd.goal"], [1]),
      ]),
    );
    expect(
      Array.map(inputsOf(PRD, SPEC, manifest).tasks, ({ id, input }) => [
        id,
        Array.map(input.others, ({ title }) => idOfTitle(title)),
      ]),
    ).toEqual([
      ["t0", ["t1", "t2"]],
      ["t1", ["t2"]],
      ["t2", []],
    ]);
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

/** `count` names with a description each. */
const entriesOf = (prefix: string, count: number) =>
  Record.fromEntries(Array.makeBy(count, (index) => [`${prefix}-${index}`, "when"] as const));

const SIZE = ["too_small", "right", "too_large"];
const models = { haiku: "Mechanical changes", opus: "Subtle logic", sonnet: "Most tasks" };
const categories = { feature: "New behaviour", ui: "Interface", test: "Tests" };

describe("the questions", () => {
  it("asks each target what the spec's table lists, of the kind it lists", () => {
    expect(Record.map(sectionQuestions.decisions, shapeOf)).toEqual({
      buildable: ["probability", []],
      faithful: ["probability", []],
      inScope: ["probability", []],
      size: ["rate", SIZE],
    });
    expect(Record.map(taskQuestions(models, categories).decisions, shapeOf)).toEqual({
      category: ["classify", ["feature", "ui", "test"]],
      inScope: ["probability", []],
      matches: ["probability", []],
      model: ["classify", ["haiku", "opus", "sonnet"]],
      ordered: ["probability", []],
      reasoning: ["rate", Reasoning.literals],
      size: ["rate", SIZE],
    });
    expect(Record.map(prdSectionQuestions.decisions, shapeOf)).toEqual({
      built: ["probability", []],
    });
    expect(Record.map(stackQuestions.decisions, shapeOf)).toEqual({
      oneFeature: ["probability", []],
    });
  });

  it.prop(
    "the model question chooses between the names in judge.models, with each one's description",
    [Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(6))],
    ([descriptions]) => {
      const named = Record.fromEntries(
        Array.map(descriptions, (description, index) => [`model-${index}`, description] as const),
      );
      const question = taskQuestions(named, categories).decisions.model;
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
      const withModel = taskQuestions(named, categories);
      expect(taskQuestionsWithoutModel.decisions).toEqual(
        Struct.omit(withModel.decisions, ["category", "model"]),
      );
      expect(taskQuestionsWithoutModel.input).toBe(withModel.input);
    },
  );

  it("names every decision of every definition as a JudgmentQuestion", () => {
    // `Judge` drops a decision key that is not a JudgmentQuestion without a word, so a question
    // missing from the contract's union would simply never be asked.
    const keys = Array.flatMap(
      [
        sectionQuestions,
        taskQuestions(models, categories),
        taskQuestionsWithoutModel,
        prdSectionQuestions,
        stackQuestions,
      ],
      (definition) => Record.keys<string, Decision.Any>(definition.decisions),
    );
    expect(Array.filter(keys, (key) => !Schema.is(JudgmentQuestion)(key))).toEqual([]);
  });

  it.prop(
    "the category question chooses between config.categories, with each one's description",
    [Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(6))],
    ([descriptions]) => {
      const named = Record.fromEntries(
        Array.map(
          descriptions,
          (description, index) => [`category-${index}`, description] as const,
        ),
      );
      expect(taskQuestions(models, named).decisions.category.criteria).toEqual(named);
    },
  );

  it.prop(
    "model and category are each asked only with two or more entries",
    [
      Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
      Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 0 })),
    ],
    ([modelCount, categoryCount]) => {
      const keys = Record.keys<string, Decision.Any>(
        taskQuestionsFor(entriesOf("model", modelCount), entriesOf("category", categoryCount))
          .decisions,
      );
      expect(Array.contains(keys, "model")).toBe(modelCount >= 2);
      expect(Array.contains(keys, "category")).toBe(categoryCount >= 2);
      expect(Array.filter(keys, (key) => key !== "model" && key !== "category")).toEqual(
        Record.keys(taskQuestionsWithoutModel.decisions),
      );
    },
  );

  it("takes the categories' descriptions from the config, and leaves the task's own category out of the input", () => {
    const config = Schema.decodeSync(Config)({});
    const fromConfig = Record.fromEntries(
      Array.map(config.categories, ({ description, name }) => [name, description] as const),
    );
    expect(taskQuestions(models, fromConfig).decisions.category.criteria).toEqual(fromConfig);
    expect(Record.keys(TaskJudgingInput.fields)).not.toContain("category");
  });

  it("asks scope apart from what is left out, of sections and of tasks", () => {
    expect(Record.keys(sectionQuestions.decisions)).toEqual(
      expect.arrayContaining(["faithful", "inScope"]),
    );
    expect(Record.keys(taskQuestionsWithoutModel.decisions)).toEqual(
      expect.arrayContaining(["matches", "inScope"]),
    );
  });

  it("describes every rating level and probability with an example", () => {
    const decisions = Array.flatMap(
      [
        sectionQuestions.decisions,
        taskQuestions(models, categories).decisions,
        prdSectionQuestions.decisions,
        stackQuestions.decisions,
      ],
      (all) => Record.values<string, Decision.Any>(all),
    );
    const described = Array.flatMap(decisions, descriptionsOf);
    expect(Array.length(described)).toBe(27);
    Array.forEach(described, (description) => {
      expect(description).toSatisfy(
        (text: unknown) => Schema.is(Schema.String)(text) && String.includes("Example: ")(text),
      );
    });
  });
});
