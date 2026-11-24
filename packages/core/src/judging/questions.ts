import { PrdSectionId, Reasoning, Slug, SpecSectionId, TaskId } from "@cairn/contract";
import type { Manifest, ManifestTask, Section } from "@cairn/contract";
import { Array, HashMap, Option, Schema, Struct, pipe } from "effect";
import { Decision } from "effect/ai";

import { sectionsOf } from "../sections.ts";

/** A section as the judge reads it: its heading text and its body. */
export const SectionText = Schema.Struct({ body: Schema.String, title: Schema.String });
export type SectionText = typeof SectionText.Type;

/** A spec section, with the PRD sections it implements (`spec.judging.questions`). */
export const SectionJudgingInput = Schema.Struct({
  body: Schema.String,
  files: Schema.Array(Schema.String),
  implements: Schema.Array(SectionText),
  title: Schema.String,
});
export type SectionJudgingInput = typeof SectionJudgingInput.Type;

/**
 * A task, with the titles of the tasks it depends on and the text of its spec and PRD sections.
 * It leaves out the planner's model and reasoning, so the judge's choice does not lean on them.
 */
export const TaskJudgingInput = Schema.Struct({
  dependsOn: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  prdSections: Schema.Array(SectionText),
  specSections: Schema.Array(SectionText),
  title: Schema.String,
});
export type TaskJudgingInput = typeof TaskJudgingInput.Type;

/**
 * The whole stack: the feature, the PRD's goal, every PRD section and every task in stack order.
 * A task carries its ID and dependencies so `ordered` can be read from the input.
 */
export const StackJudgingInput = Schema.Struct({
  feature: Slug,
  goal: Schema.String,
  prdSections: Schema.Array(Schema.Struct({ id: PrdSectionId, title: Schema.String })),
  tasks: Schema.Array(
    Schema.Struct({
      dependsOn: Schema.Array(TaskId),
      id: TaskId,
      prdSections: Schema.Array(PrdSectionId),
      specSections: Schema.Array(SpecSectionId),
      title: Schema.String,
    }),
  ),
});
export type StackJudgingInput = typeof StackJudgingInput.Type;

/** The questions for a spec section. */
export const sectionQuestions = Decision.make({
  decisions: {
    buildable: Decision.probability({
      criteria: {
        false:
          "An agent would have to ask what to build. Example: a section that says to store sessions somewhere durable but names no store, table, function or file.",
        true: "The text and files settle what to write and how to test it. Example: spec.planning.stack-order names its files, the signature of stackOf and the properties its tests check.",
      },
      instructions:
        "An agent could build this section from its text and files without asking a question.",
    }),
    faithful: Decision.probability({
      criteria: {
        false:
          "It leaves out what its PRD sections ask, or adds behaviour they do not ask for. Example: a section implementing prd.judging-the-plan that lets the judge rewrite a spec section a human wrote, which the PRD forbids.",
        true: "It does what its PRD sections ask and nothing more. Example: spec.judging.questions asks the decision model the questions prd.judging-the-plan lists at each checkpoint, and no others.",
      },
      instructions:
        "The section does what the PRD sections it implements ask, and adds no behaviour they do not ask for.",
    }),
    size: Decision.rate({
      criteria: [
        {
          description:
            "A detail of a neighbouring section, less than one task. Example: a section only for the stale flag on a judgment in the Trace, which belongs in spec.contract.trace.",
          label: "too_small",
        },
        {
          description:
            "One to three tasks' worth of one feature. Example: spec.judging.verdicts, one pure function and its properties, built by one task.",
          label: "right",
        },
        {
          description:
            "Several features, each of which could be planned and shipped alone. Example: one section for the trace store, the session reader and the session pane together.",
          label: "too_large",
        },
      ],
      instructions:
        "Is this spec section one to three tasks' worth of work, or a detail of a neighbouring section, or several features?",
    }),
  },
  input: SectionJudgingInput,
});

/** The reasoning levels a task can run with, lowest first, as the manifest names them. */
const REASONING = [
  {
    description:
      "Following a pattern the repo already has. Example: t56 adds the spec index schema beside the other contract schemas.",
    label: "low",
  },
  {
    description:
      "An ordinary service or command with its tests. Example: t21 adds the Git service with live and in-memory layers.",
    label: "medium",
  },
  {
    description:
      "Logic with properties to get right across several cases. Example: t17 parses markdown into sections with inherited keys and human tags.",
    label: "high",
  },
  {
    description:
      "Ordering or derivation where a subtle mistake breaks every task after it. Example: t20 orders drafts into stacks by dependency.",
    label: "xhigh",
  },
  {
    description:
      "A new algorithm with many interacting invariants and no pattern in the repo to follow. Example: none of this repo's tasks yet; t20, ordering drafts into stacks, was planned one level lower.",
    label: "max",
  },
] as const satisfies ReadonlyArray<{ readonly description: string; readonly label: Reasoning }>;

/**
 * The questions for a task. `model` classifies the task into one of `models`, the names in
 * `judge.models` with when to use each, so the definition is built from config.
 * `Decision.classify` throws when `models` names fewer than two models, which `Config` still
 * accepts: a caller with fewer than two has no model to choose and must not build this.
 */
export const taskQuestions = (models: { readonly [name: string]: string }) =>
  Decision.make({
    decisions: {
      matches: Decision.probability({
        criteria: {
          false:
            "Its title or files leave out what its spec sections ask, or reach past them. Example: a task for spec.lint whose files leave out packages/cli/src/commands/lint.ts, or add a viewer file the section never names.",
          true: "Its title and files carry out its spec sections and nothing else. Example: t59, Turn answers into verdicts and routes, touches verdicts.ts and its test, as spec.judging.verdicts asks.",
        },
        instructions:
          "The task's title and files carry out its spec sections, and nothing they do not ask.",
      }),
      model: Decision.classify({
        criteria: models,
        instructions:
          "Which model does this task need? Choose from each model's description of when to use it.",
      }),
      reasoning: Decision.rate({
        criteria: REASONING,
        instructions: "How much reasoning does this task's work need?",
      }),
      size: Decision.rate({
        criteria: [
          {
            description:
              "Less than a diff worth reviewing alone. Example: exporting inputsOf from core's index, a line that belongs with the task that writes inputsOf.",
            label: "too_small",
          },
          {
            description:
              "One reviewable diff from one agent session. Example: t58, Define the judging questions and their inputs: one file, its export and its tests.",
            label: "right",
          },
          {
            description:
              "More than one agent session or one review. Example: one task that adds the Judge service, the checkpoints in cairn plan and cairn judge.",
            label: "too_large",
          },
        ],
        instructions: "Is this task one reviewable diff that one agent session can build?",
      }),
    },
    input: TaskJudgingInput,
  });

/** The questions for the whole stack. */
export const stackQuestions = Decision.make({
  decisions: {
    complete: Decision.probability({
      criteria: {
        false:
          "Some PRD section listed has no task that builds it. Example: prd.viewer.notes listed with no task whose sections reach it.",
        true: "Every PRD section listed is built by some task. Example: prd.judging-the-plan, built by t55 through t67.",
      },
      instructions: "Together the tasks build every PRD section listed.",
    }),
    oneFeature: Decision.probability({
      criteria: {
        false:
          "It bundles features that could each ship alone. Example: one stack that adds the viewer's fuzzy search and the Redactor service.",
        true: "Its tasks serve one feature. Example: the judging tasks t55 to t67, which all serve judging the plan.",
      },
      instructions: "The stack builds one feature, not several that could ship alone.",
    }),
    ordered: Decision.probability({
      criteria: {
        false:
          "Some task needs a task it does not depend on. Example: a task that tests cairn judge end to end without depending on the Judge service it calls.",
        true: "Each task needs only what it depends on. Example: t59 builds verdicts on t58's questions and t55's judgments schema, and depends on both.",
      },
      instructions: "Each task can be built and tested with only the tasks it depends on.",
    }),
  },
  input: StackJudgingInput,
});

/** What `inputsOf` returns: one input per spec section, per task and for the stack. */
export interface JudgingInputs {
  readonly sections: ReadonlyArray<{
    readonly id: SpecSectionId;
    readonly input: SectionJudgingInput;
  }>;
  readonly stack: StackJudgingInput;
  readonly tasks: ReadonlyArray<{ readonly id: TaskId; readonly input: TaskJudgingInput }>;
}

const textOf = ({ body, title }: Section): SectionText => ({ body, title });

/** Each section with an ID, keyed by it. Keys are plain strings, so a PRD or spec ID finds it. */
const byId = (sections: ReadonlyArray<Section>): HashMap.HashMap<string, Section> =>
  HashMap.fromIterable(
    Array.getSomes(
      Array.map(sections, (section) =>
        Option.map(Option.fromUndefinedOr(section.id), (id) => [id, section] as const),
      ),
    ),
  );

/** The text of each ID's section, in the order given; an ID no section has is left out. */
const textsOf = (
  sections: HashMap.HashMap<string, Section>,
  ids: ReadonlyArray<string>,
): ReadonlyArray<SectionText> =>
  Array.getSomes(Array.map(ids, (id) => Option.map(HashMap.get(sections, id), textOf)));

/** The PRD's goal: the body of `prd.goal`, or the body of its first heading when it has none. */
const goalOf = (prd: ReadonlyArray<Section>, prdById: HashMap.HashMap<string, Section>): string =>
  pipe(
    HashMap.get(prdById, "prd.goal"),
    Option.orElse(() => Array.head(prd)),
    Option.match({ onNone: () => "", onSome: ({ body }) => body }),
  );

const isSpecSectionId = Schema.is(SpecSectionId);
const isPrdSectionId = Schema.is(PrdSectionId);

/**
 * The inputs to judge, from `prd.md`, `spec.md` and the manifest. Pure.
 *
 * - One per spec section that has an ID, in document order.
 * - One per task, in manifest order. A dependency, spec or PRD section the files do not have is
 *   left out; lint reports it.
 * - One for the stack, with every PRD section that has an ID.
 */
export const inputsOf = (prd: string, spec: string, manifest: Manifest): JudgingInputs => {
  const prdSections = sectionsOf(prd);
  const specSections = sectionsOf(spec);
  const prdById = byId(prdSections);
  const specById = byId(specSections);
  const titles = HashMap.fromIterable(
    Array.map(manifest.tasks, (task) => [task.id, task.title] as const),
  );

  const sections = Array.getSomes(
    Array.map(specSections, (section) =>
      pipe(
        Option.fromUndefinedOr(section.id),
        Option.filter(isSpecSectionId),
        Option.map((id) => ({
          id,
          input: {
            body: section.body,
            files: section.keys.files,
            implements: textsOf(prdById, section.keys.implements),
            title: section.title,
          },
        })),
      ),
    ),
  );

  const taskInputOf = (task: ManifestTask): TaskJudgingInput => ({
    dependsOn: Array.getSomes(Array.map(task.dependsOn, (id) => HashMap.get(titles, id))),
    files: task.files,
    prdSections: textsOf(prdById, task.prdSections),
    specSections: textsOf(specById, task.specSections),
    title: task.title,
  });

  return {
    sections,
    stack: {
      feature: manifest.feature,
      goal: goalOf(prdSections, prdById),
      prdSections: Array.getSomes(
        Array.map(prdSections, ({ id, title }) =>
          pipe(
            Option.fromUndefinedOr(id),
            Option.filter(isPrdSectionId),
            Option.map((prdId) => ({ id: prdId, title })),
          ),
        ),
      ),
      tasks: Array.map(
        manifest.tasks,
        Struct.pick(["dependsOn", "id", "prdSections", "specSections", "title"]),
      ),
    },
    tasks: Array.map(manifest.tasks, (task) => ({ id: task.id, input: taskInputOf(task) })),
  };
};
