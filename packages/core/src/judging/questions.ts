import { PrdSectionId, Reasoning, Slug, SpecSectionId, TaskId } from "@cairn/contract";
import type { Manifest, ManifestTask, Section } from "@cairn/contract";
import {
  Array,
  HashMap,
  HashSet,
  Match,
  Number,
  Option,
  Order,
  Record,
  Schema,
  Struct,
  pipe,
} from "effect";
import { Decision } from "effect/ai";

import { itemsOf } from "../items.ts";
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

/** Another task as a task's `others` names it: its title and files. */
export const OtherTask = Schema.Struct({
  files: Schema.Array(Schema.String),
  title: Schema.String,
});
export type OtherTask = typeof OtherTask.Type;

/** The most tasks a task's `others` holds, so a request stays small in a large plan. */
export const MAX_OTHERS = 10;

/**
 * A task, with the titles of the tasks it depends on and the text of its spec and PRD sections.
 * It leaves out the planner's model and reasoning, so the judge's choice does not lean on them.
 * `others` holds up to `MAX_OTHERS` tasks it does not depend on, directly or through other tasks,
 * that share a spec section, PRD section or file with it, so `ordered` can ask whether it needs one
 * of them. A task that depends on it is among them, so a dependency written the wrong way round
 * shows.
 */
export const TaskJudgingInput = Schema.Struct({
  dependsOn: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  others: Schema.Array(OtherTask),
  prdSections: Schema.Array(SectionText),
  specSections: Schema.Array(SectionText),
  title: Schema.String,
});
export type TaskJudgingInput = typeof TaskJudgingInput.Type;

/** A task that implements a PRD section, as that section's input names it. */
export const BuildingTask = Schema.Struct({
  files: Schema.Array(Schema.String),
  specSections: Schema.Array(Schema.String),
  title: Schema.String,
});
export type BuildingTask = typeof BuildingTask.Type;

/**
 * A PRD section some task implements: its title and body, and each task that implements it with
 * its title, files and the titles of its spec sections (`spec.judging.questions`).
 */
export const PrdSectionJudgingInput = Schema.Struct({
  body: Schema.String,
  tasks: Schema.Array(BuildingTask),
  title: Schema.String,
});
export type PrdSectionJudgingInput = typeof PrdSectionJudgingInput.Type;

/**
 * The whole stack: the feature, the PRD's goal, every PRD section and every task in stack order,
 * for `oneFeature`.
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
          "Something its PRD sections ask has no place in it. Example: a section implementing prd.judging-the-plan that says what the judge does with a too_large section but never says what happens to a section a person wrote.",
        true: "Everything its PRD sections ask is in it, including the cases they name. Example: spec.judging.questions asks the decision model each question prd.judging-the-plan lists at its checkpoints.",
      },
      instructions: "The section does everything the PRD sections it implements ask.",
    }),
    inScope: Decision.probability({
      criteria: {
        false:
          "It specifies behaviour none of its PRD sections ask for. Example: a section implementing prd.judging-the-plan that lets the judge rewrite a spec section a human wrote, which the PRD forbids.",
        true: "Everything it specifies is something its PRD sections ask for. Example: spec.judging.verdicts turns each answer into pass, flag or unsure and picks the model, as prd.judging-the-plan asks, and adds no other behaviour.",
      },
      instructions: "The section adds no behaviour the PRD sections it implements do not ask for.",
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
 * The task questions without `model`: `inScope`, `matches`, `ordered`, `reasoning` and `size`, which do
 * not depend on config. The judge asks these alone when `judge.models` names fewer than two models, since there
 * is nothing to choose between; `taskQuestions` adds `model` to them.
 */
export const taskQuestionsWithoutModel = Decision.make({
  decisions: {
    inScope: Decision.probability({
      criteria: {
        false:
          "Its title or files reach for something none of its spec sections ask for. Example: a task for spec.judging.verdicts whose files add a viewer file the section never names. A test of its own files, or the export of what it adds, is not past its sections.",
        true: "Everything in its title and files is something its spec sections ask for. Example: t58, Define the judging questions and their inputs, touches questions.ts, its export and its test, which spec.judging.questions names.",
      },
      instructions: "The task's title and files reach for nothing its spec sections do not ask.",
    }),
    matches: Decision.probability({
      criteria: {
        false:
          "Its title or files leave out what its spec sections ask. Example: a task for spec.lint whose files leave out packages/cli/src/commands/lint.ts.",
        true: "Its title and files carry out everything its spec sections ask. Example: t59, Turn answers into verdicts and routes, touches verdicts.ts and its test, as spec.judging.verdicts asks.",
      },
      instructions: "The task's title and files carry out what its spec sections ask.",
    }),
    ordered: Decision.probability({
      criteria: {
        false:
          "It reads, calls or tests something that only a task in `others` adds. Example: a task that tests cairn judge end to end while the task adding the Judge service in packages/cli/src/judge.ts is in `others`, not among the tasks it depends on.",
        true: "What it needs is in its own files or in the tasks it depends on; the tasks in `others` only touch the same sections or files. Example: t59, Turn answers into verdicts and routes, builds on t58's questions and t55's judgments schema and depends on both, and a task in `others` that also edits questions.ts adds nothing t59 reads.",
      },
      instructions:
        "The task can be built and tested with only the tasks it depends on, needing nothing from `others`.",
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

/** Names with a description each: `judge.models`, or `config.categories` as a record. */
export interface Described {
  readonly [name: string]: string;
}

const modelDecision = (models: Described) =>
  Decision.classify({
    criteria: models,
    instructions:
      "Which model does this task need? Choose from each model's description of when to use it.",
  });

const categoryDecision = (categories: Described) =>
  Decision.classify({
    criteria: categories,
    instructions:
      "Which category does this task's work fit? Choose from each category's description.",
  });

/**
 * The questions for a task with both choices: `taskQuestionsWithoutModel`, `model`, which
 * classifies the task into one of `models` (the names in `judge.models` with when to use each),
 * and `category`, which classifies it into one of `categories` (the names in `config.categories`
 * with what each is for), so the definition is built from config. `Decision.classify` throws when
 * either names fewer than two entries, which `Config` still accepts: a caller with fewer than two
 * has nothing to choose and must not build this; `taskQuestionsFor` leaves the question out.
 */
export const taskQuestions = (models: Described, categories: Described) =>
  Decision.make({
    decisions: Struct.assign(taskQuestionsWithoutModel.decisions, {
      category: categoryDecision(categories),
      model: modelDecision(models),
    }),
    input: TaskJudgingInput,
  });

/**
 * The task questions config allows: `model` only when `models` names two or more, `category`
 * only when `categories` does, since one entry leaves nothing to choose.
 */
export const taskQuestionsFor = (models: Described, categories: Described) => {
  const base = taskQuestionsWithoutModel.decisions;
  const twoOrMore = (described: Described) => Record.size(described) >= 2;
  return Match.value([twoOrMore(models), twoOrMore(categories)] as const).pipe(
    Match.when([true, true], () => taskQuestions(models, categories)),
    Match.when([true, false], () =>
      Decision.make({
        decisions: Struct.assign(base, { model: modelDecision(models) }),
        input: TaskJudgingInput,
      }),
    ),
    Match.when([false, true], () =>
      Decision.make({
        decisions: Struct.assign(base, { category: categoryDecision(categories) }),
        input: TaskJudgingInput,
      }),
    ),
    Match.orElse(() => taskQuestionsWithoutModel),
  );
};

/** The question for a PRD section that some task implements. */
export const prdSectionQuestions = Decision.make({
  decisions: {
    built: Decision.probability({
      criteria: {
        false:
          "Something the section asks for is in no task's title, files or spec sections. Example: prd.viewer.notes asks the viewer to show a task's notes, and its tasks add the notes store and cairn note but none of them touches apps/viewer.",
        true: "Each thing the section asks for is in some task's title, files or spec sections. Example: prd.cli, whose item for cairn judge is built by t65, Add cairn judge, with packages/cli/src/commands/judge.ts in its files.",
      },
      instructions: "The tasks in `tasks` together build what the section asks for.",
    }),
  },
  input: PrdSectionJudgingInput,
});

/** The question for the whole stack. */
export const stackQuestions = Decision.make({
  decisions: {
    oneFeature: Decision.probability({
      criteria: {
        false:
          "It bundles features that could each ship alone. Example: one stack that adds the viewer's fuzzy search and the Redactor service.",
        true: "Its tasks serve one feature. Example: the judging tasks t55 to t67, which all serve judging the plan.",
      },
      instructions: "The stack builds one feature, not several that could ship alone.",
    }),
  },
  input: StackJudgingInput,
});

/**
 * What `inputsOf` returns: one input per spec section, per task, per PRD section some task
 * implements, and for the stack.
 */
export interface JudgingInputs {
  readonly prdSections: ReadonlyArray<{
    readonly id: PrdSectionId;
    readonly input: PrdSectionJudgingInput;
  }>;
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

/** What a task links to: the PRD and spec sections it names. */
type Linked = Pick<ManifestTask, "prdSections" | "specSections">;

/**
 * The PRD headings a task implements, by the rollup rule of `spec.sections.item-coverage`: those
 * its `prdSections` name and those its spec sections' `Implements` name, a list item standing
 * for the heading it is under.
 */
const builtByOf = (
  prd: string,
  prdSections: ReadonlyArray<Section>,
  specById: HashMap.HashMap<string, Section>,
) => {
  const headingOfItem = HashMap.fromIterable(
    Array.getSomes(
      Array.map(itemsOf(prd, prdSections), ({ id, section }) =>
        Option.map(
          Option.all([Option.fromUndefinedOr(id), Option.fromUndefinedOr(section)]),
          ([item, heading]): readonly [string, string] => [item, heading],
        ),
      ),
    ),
  );
  return (task: Linked): HashSet.HashSet<string> =>
    HashSet.fromIterable(
      Array.map(
        Array.appendAll<string, string>(
          task.prdSections,
          Array.flatMap(task.specSections, (id) =>
            Option.match(HashMap.get(specById, id), {
              onNone: (): ReadonlyArray<string> => [],
              onSome: ({ keys }) => keys.implements,
            }),
          ),
        ),
        (id) => Option.getOrElse(HashMap.get(headingOfItem, id), () => id),
      ),
    );
};

/** The PRD headings with an ID, in document order, that some of `tasks` implements. */
const builtSectionsOf = (
  prdSections: ReadonlyArray<Section>,
  builtBy: (task: Linked) => HashSet.HashSet<string>,
  tasks: ReadonlyArray<Linked>,
): ReadonlyArray<{ readonly id: PrdSectionId; readonly section: Section }> => {
  const built = HashSet.fromIterable(
    Array.flatMap(tasks, (task) => Array.fromIterable(builtBy(task))),
  );
  return Array.getSomes(
    Array.map(prdSections, (section) =>
      pipe(
        Option.fromUndefinedOr(section.id),
        Option.filter(isPrdSectionId),
        Option.filter((id) => HashSet.has(built, id)),
        Option.map((id) => ({ id, section })),
      ),
    ),
  );
};

/**
 * The PRD sections, in document order, that some of `tasks` implements: what `cairn plan`'s fourth
 * checkpoint asks `built` of (`spec.judging.checkpoints`). A task implements a PRD section its
 * `prdSections` name, one a spec section it builds implements, and the section holding a list item
 * either names.
 */
export const prdSectionsBuiltBy = (
  prd: string,
  spec: string,
  tasks: ReadonlyArray<Linked>,
): ReadonlyArray<PrdSectionId> => {
  const prdSections = sectionsOf(prd);
  return Array.map(
    builtSectionsOf(prdSections, builtByOf(prd, prdSections, byId(sectionsOf(spec))), tasks),
    Struct.get("id"),
  );
};

/** Every task reached from `start` by following `next`, without `start` unless a cycle returns to it. */
const reachedFrom = (
  next: (id: string) => ReadonlyArray<string>,
  start: string,
): HashSet.HashSet<string> => {
  const walk = (
    seen: HashSet.HashSet<string>,
    frontier: ReadonlyArray<string>,
  ): HashSet.HashSet<string> => {
    const fresh = Array.dedupe(
      Array.filter(Array.flatMap(frontier, next), (id) => !HashSet.has(seen, id)),
    );
    return Array.isReadonlyArrayEmpty(fresh)
      ? seen
      : walk(HashSet.union(seen, HashSet.fromIterable(fresh)), fresh);
  };
  return walk(HashSet.empty(), [start]);
};

/** How many spec sections, PRD sections and files two tasks share. */
const sharedBy = (
  a: Pick<ManifestTask, "files" | "prdSections" | "specSections">,
  b: Pick<ManifestTask, "files" | "prdSections" | "specSections">,
): number =>
  Number.sumAll([
    Array.length(Array.intersection(a.specSections, b.specSections)),
    Array.length(Array.intersection(a.prdSections, b.prdSections)),
    Array.length(Array.intersection(a.files, b.files)),
  ]);

/** The tasks `record` lists for `id`, none when it lists none. */
const edges =
  (record: Record.ReadonlyRecord<string, ReadonlyArray<string>>) =>
  (id: string): ReadonlyArray<string> =>
    Option.getOrElse(Record.get(record, id), (): ReadonlyArray<string> => []);

/**
 * Each task's `others`: up to `MAX_OTHERS` tasks that it does not depend on, directly or through
 * other tasks, and that share a spec section, PRD section or file with it; those sharing the most
 * first, then in manifest order. A task that depends on it is kept, so `ordered` can see a
 * dependency written the wrong way round.
 */
const othersOf = (tasks: ReadonlyArray<ManifestTask>) => {
  const dependsOn = Record.fromIterableWith(tasks, (task) => [task.id, task.dependsOn]);
  return (task: ManifestTask): ReadonlyArray<OtherTask> => {
    const needed = reachedFrom(edges(dependsOn), task.id);
    return pipe(
      tasks,
      Array.filter((other) => other.id !== task.id && !HashSet.has(needed, other.id)),
      Array.map((other) => ({ other, shared: sharedBy(task, other) })),
      Array.filter(({ shared }) => shared > 0),
      Array.sortWith(Struct.get("shared"), Order.flip(Order.Number)),
      Array.take(MAX_OTHERS),
      Array.map(({ other }) => ({ files: other.files, title: other.title })),
    );
  };
};

/**
 * The inputs to judge, from `prd.md`, `spec.md` and the manifest. Pure.
 *
 * - One per spec section that has an ID, in document order.
 * - One per task, in manifest order. A dependency, spec or PRD section the files do not have is
 *   left out; lint reports it. Its `others` are found as `othersOf` says.
 * - One per PRD section with an ID that some task implements, in document order, with only the
 *   tasks that implement it, in manifest order.
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
  const builtBy = builtByOf(prd, prdSections, specById);
  const others = othersOf(manifest.tasks);

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
    others: others(task),
    prdSections: textsOf(prdById, task.prdSections),
    specSections: textsOf(specById, task.specSections),
    title: task.title,
  });

  const prdInputOf = (id: PrdSectionId, section: Section): PrdSectionJudgingInput => ({
    body: section.body,
    tasks: Array.map(
      Array.filter(manifest.tasks, (task) => HashSet.has(builtBy(task), id)),
      (task) => ({
        files: task.files,
        specSections: Array.map(textsOf(specById, task.specSections), Struct.get("title")),
        title: task.title,
      }),
    ),
    title: section.title,
  });

  return {
    prdSections: Array.map(
      builtSectionsOf(prdSections, builtBy, manifest.tasks),
      ({ id, section }) => ({
        id,
        input: prdInputOf(id, section),
      }),
    ),
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
