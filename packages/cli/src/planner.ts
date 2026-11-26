import { IndexProse, PrdSectionId, TaskDraft, defaultConfig } from "@cairn/contract";
import type {
  Category,
  Config,
  ManifestTask,
  Section,
  SectionKeys,
  SpecSectionId,
} from "@cairn/contract";
import { drawsOf, mermaidBlocksOf, sectionsOf, withoutMermaidBlocks } from "@cairn/core";
import type { Drafted } from "@cairn/core";
import {
  Array,
  Console,
  Context,
  Duration,
  Effect,
  FileSystem,
  HashSet,
  Layer,
  Match,
  Number,
  Option,
  Order,
  Path,
  Predicate,
  Record,
  Ref,
  Result,
  Schema,
  String,
} from "effect";
import { AiError, Chat, LanguageModel, Prompt } from "effect/ai";

import { SmallLanguageModel, isSmallCall } from "./models.ts";

/** Why a planner call failed: the model could not be reached, or its reply never decoded. */
export class PlannerError extends Schema.TaggedError<
  PlannerError,
  { readonly brand: unique symbol }
>()("PlannerError", {
  call: Schema.Literals([
    "spec",
    "sections",
    "tasks",
    "splitSection",
    "splitTask",
    "index",
    "statements",
  ]),
  reason: Schema.String,
}) {}

/**
 * What `tasks` asks the model for. A structured output is an object, so the drafts sit under a
 * key.
 */
export const TaskDrafts = Schema.Struct({ drafts: Schema.Array(TaskDraft) });

/** The part of the PRD a run plans: its `Part.ids` (see `spec.planning.planning-a-part`). */
export type PartIds = HashSet.HashSet<PrdSectionId>;

const idsOfPart = (part: PartIds): ReadonlyArray<PrdSectionId> =>
  Array.sort(Array.fromIterable(part), Order.String);

/** The IDs of `ids` that are not in `part`, each once. */
const outsideOf = (part: PartIds, ids: ReadonlyArray<PrdSectionId>) =>
  Array.dedupe(Array.filter(ids, (id) => !HashSet.has(part, id)));

/** The keys of a spec section that may name only the part's IDs. */
const partKeysOf = (keys: SectionKeys) =>
  [
    ["Implements", keys.implements],
    ["Defers", keys.defers],
    ["Context", keys.context],
  ] as const;

/**
 * `markdown` without its `- Under:` lines. A reply of `Planner.sections` puts `Under` first in a
 * section's key list, `sectionsOf` does not know it and stops reading keys there, and the merge
 * takes it out afterwards, so the keys after it count once it is gone.
 */
const withoutUnderKeys = (markdown: string) =>
  Array.join(
    Array.filter(String.split("\n")(markdown), (line) => !String.startsWith("- Under:")(line)),
    "\n",
  );

/**
 * What is wrong with new or rewritten spec sections for a part run, one line each: a section whose
 * `Implements`, `Defers` or `Context` names a PRD ID outside the part. Naming an outside section
 * in `Context` or `Defers` would cover it, so the run would never plan it.
 */
export const outsidePartIn = (part: PartIds, markdown: string): ReadonlyArray<string> =>
  Array.flatMap(sectionsOf(withoutUnderKeys(markdown)), (section) =>
    Array.filterMap(partKeysOf(section.keys), ([key, ids]) => {
      const outside = outsideOf(part, ids);
      return Array.isReadonlyArrayNonEmpty(outside)
        ? Result.succeed(
            `The section ${Option.getOrElse(Option.fromUndefinedOr(section.id), () => section.title)} has ${key} naming ${Array.join(outside, ", ")}, which is not in the part. ${key} may name only IDs in the part; if the part needs a section outside it, say so in the prose with a line that starts \`Assumes:\` and leave it out of the keys.`,
          )
        : Result.failVoid;
    }),
  );

/**
 * `TaskDrafts`, and every draft's `prdSections` lie in `part` and its `specSections` in
 * `specSections`, so a reply that reaches past the part fails to decode and is sent back once.
 */
const draftsInPart = (part: PartIds, specSections: ReadonlyArray<SpecSectionId>) =>
  TaskDrafts.check(
    Schema.makeFilter(({ drafts }) => {
      const problems = Array.flatMap(drafts, (draft) => {
        const prd = outsideOf(part, draft.prdSections);
        const spec = Array.filter(draft.specSections, (id) => !Array.contains(specSections, id));
        return Array.appendAll(
          Array.isReadonlyArrayNonEmpty(prd)
            ? [
                `The task "${draft.title}" has prdSections naming ${Array.join(prd, ", ")}, which is not in the part.`,
              ]
            : [],
          Array.isReadonlyArrayNonEmpty(spec)
            ? [
                `The task "${draft.title}" has specSections naming ${Array.join(spec, ", ")}, which is not a spec section to draft tasks for.`,
              ]
            : [],
        );
      });
      return Array.isReadonlyArrayNonEmpty(problems) ? Array.join(problems, "\n") : undefined;
    }),
  );

/**
 * Refuses a reply with a draft whose category is not one of `categories` (`spec.planning.task-categories`),
 * so it is sent back once like any other failed decode.
 */
const inCategories = (categories: ReadonlyArray<Category>) =>
  Schema.makeFilter<{ readonly drafts: ReadonlyArray<TaskDraft> }>(({ drafts }) => {
    const names = Array.map(categories, ({ name }) => name);
    const problems = Array.filterMap(drafts, (draft) =>
      Array.contains(names, draft.category)
        ? Result.failVoid
        : Result.succeed(
            `The task "${draft.title}" has the category ${draft.category}, which is not in the list. Use one of: ${Array.join(names, ", ")}.`,
          ),
    );
    return Array.isReadonlyArrayNonEmpty(problems) ? Array.join(problems, "\n") : undefined;
  });

/** What `splitTask` asks the model for: the drafts that replace one, so at least two. */
export const SplitDrafts = Schema.Struct({
  drafts: Schema.Array(TaskDraft).check(Schema.isMinLength(2)),
});

/** A draft as JSON text, for the `splitTask` prompt. */
const DraftJson = Schema.fromJsonString(TaskDraft, { space: 2 });

/** The part of a section `index` reads: its ID, to name the items, and its text. */
export type IndexTarget = Pick<Section, "body" | "title"> & { readonly id: SpecSectionId };

/** What `statements` asks the model for: one item for each target, with the drafts for it. */
export const StatementDrafts = Schema.Struct({
  statements: Schema.Array(
    Schema.Struct({ drafts: Schema.Array(Schema.String), target: PrdSectionId }),
  ),
});

/**
 * `StatementDrafts` with exactly one item for each of `targets`, so a reply about another part
 * cannot be written into the PRD and a part the model skipped is asked for again. A part with
 * nothing to build has an item with no drafts.
 */
const statementDraftsOf = (targets: ReadonlyArray<PrdSectionId>) =>
  StatementDrafts.check(
    Schema.makeFilter((reply) => {
      const named = Array.map(reply.statements, (item) => item.target);
      const foreign = Array.filter(named, (target) => !Array.contains(targets, target));
      const missing = Array.filter(targets, (target) => !Array.contains(named, target));
      const repeated = Array.filter(
        Array.dedupe(named),
        (target) => Array.length(Array.filter(named, (other) => other === target)) > 1,
      );
      const problems = Array.flatten([
        Array.isReadonlyArrayNonEmpty(foreign)
          ? [`these targets were not asked about: ${Array.join(foreign, ", ")}`]
          : [],
        Array.isReadonlyArrayNonEmpty(missing)
          ? [`these targets have no item: ${Array.join(missing, ", ")}`]
          : [],
        Array.isReadonlyArrayNonEmpty(repeated)
          ? [`these targets have more than one item: ${Array.join(repeated, ", ")}`]
          : [],
      ]);
      return Array.isReadonlyArrayNonEmpty(problems) ? Array.join(problems, "; ") : undefined;
    }),
  );

/**
 * `IndexProse`, and every item's ID starts with the section's ID and `#`, so a reply about
 * another section cannot be written into this one's entry.
 */
const indexProseOf = (id: SpecSectionId) =>
  IndexProse.check(
    Schema.makeFilter((prose) => {
      const foreign = Array.filter(
        Array.flatten([
          Array.map(prose.artifacts, (item) => item.id),
          Array.map(prose.decisions, (item) => item.id),
          Array.map(prose.requirements, (item) => item.id),
          Array.map(prose.tests, (item) => item.id),
        ]),
        (item) => !String.startsWith(`${id}#`)(item),
      );
      return Array.isReadonlyArrayNonEmpty(foreign)
        ? `Every item ID must start with ${id}#, but these do not: ${Array.join(foreign, ", ")}`
        : undefined;
    }),
  );

/** Why a prompt could not be made: its file could not be read, or its placeholders do not match. */
export class PromptError extends Schema.TaggedError<
  PromptError,
  { readonly brand: unique symbol }
>()("PromptError", {
  prompt: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `The ${this.prompt} prompt: ${this.reason}`;
  }
}

/** Splitting on a pattern with one capture group alternates text (even) and names (odd). */
const isSlot = (index: number) => Number.remainder(index, 2) === 1;

/** A `{{name}}` placeholder, with its name as the one capture group. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/u;

/**
 * Fills the `{{name}}` placeholders of a prompt template from `values`. A placeholder with no
 * value, and a value with no placeholder, are both a `PromptError`: a prompt that silently kept
 * `{{prd}}` or dropped a part of its input would go to the model unnoticed. The template is read
 * once, so a value that holds `{{...}}` or `$&` goes in as it is.
 */
export const fillPrompt = Effect.fn("fillPrompt")(function* (
  prompt: string,
  template: string,
  values: Readonly<Record<string, string>>,
) {
  const parts = String.split(template, PLACEHOLDER);
  const slots = Array.filterMap(parts, (part, index) =>
    isSlot(index) ? Result.succeed(part) : Result.failVoid,
  );
  const unfilled = Array.dedupe(Array.filter(slots, (name) => !Record.has(values, name)));
  const unused = Array.filter(Record.keys(values), (name) => !Array.contains(slots, name));
  if (Array.isReadonlyArrayNonEmpty(unfilled) || Array.isReadonlyArrayNonEmpty(unused)) {
    return yield* new PromptError({
      prompt,
      reason: Array.join(
        Array.appendAll(
          Array.map(unfilled, (name) => `the template has a placeholder ${name} with no value`),
          Array.map(unused, (name) => `a value was given for ${name}, which the template lacks`),
        ),
        "; ",
      ),
    });
  }
  return Array.join(
    Array.map(parts, (part, index) =>
      isSlot(index) ? Option.getOrElse(Record.get(values, part), () => part) : part,
    ),
    "",
  );
});

/** The prompt files of `packages/cli/prompts/`, next to `src/`. */
const promptUrl = (name: string) => new URL(`../prompts/${name}.md`, import.meta.url);

/**
 * The worked example of the spec prompt is this repository's own spec (`spec.planning.planner-service`).
 * It is read from `.cairn/spec.md` by its path from this file, not copied under `prompts/`, so the
 * example cannot drift from the spec. A known limit: the CLI has to run from a checkout of this
 * repository (it is a private package of this monorepo) or the file is missing, and the layer
 * fails with a `PromptError` naming it.
 */
const exampleUrl = new URL("../../../.cairn/spec.md", import.meta.url);

const readText = Effect.fn("readText")(
  function* (_prompt: string, url: URL) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* path.fromFileUrl(url);
    return yield* fs.readFileString(file);
  },
  (effect, prompt) =>
    Effect.mapError(effect, (error) => new PromptError({ prompt, reason: error.message })),
);

/** The prompts, each a function of what its call knows. */
export interface Prompts {
  /**
   * The follow-up turn that asks again after a reply was refused. It goes in the same chat as the
   * first prompt and the refused reply, so it carries only the error.
   */
  readonly retry: (error: string) => Effect.Effect<string, PromptError>;
  readonly spec: (prd: string) => Effect.Effect<string, PromptError>;
  readonly sections: (
    prd: string,
    spec: string,
    prdSections: ReadonlyArray<PrdSectionId>,
    rewrite: ReadonlyArray<SpecSectionId>,
    part?: PartIds,
  ) => Effect.Effect<string, PromptError>;
  readonly tasks: (
    prd: string,
    spec: string,
    specSections: ReadonlyArray<SpecSectionId>,
    existing: ReadonlyArray<ManifestTask>,
    part?: PartIds,
  ) => Effect.Effect<string, PromptError>;
  /** The system message every `splitTask` of a round shares: the spec, the categories and the models. */
  readonly splitOpening: (spec: string) => Effect.Effect<string, PromptError>;
  /** One split's turn after `splitOpening`. `draft` is the draft as JSON. */
  readonly splitTask: (draft: string, reason: string) => Effect.Effect<string, PromptError>;
  readonly splitSection: (section: string, reason: string) => Effect.Effect<string, PromptError>;
  readonly index: (section: IndexTarget) => Effect.Effect<string, PromptError>;
  readonly statements: (
    prd: string,
    targets: ReadonlyArray<PrdSectionId>,
  ) => Effect.Effect<string, PromptError>;
}

/** IDs as a list of code spans, or `none` when there are none. */
const idList = (ids: ReadonlyArray<string>) =>
  Array.match(ids, {
    onEmpty: () => "none",
    onNonEmpty: (some) =>
      Array.join(
        Array.map(some, (id) => `\`${id}\``),
        ", ",
      ),
  });

/** The tasks the manifest already has, one bullet each, for the `tasks` prompt. */
const existingList = (tasks: ReadonlyArray<ManifestTask>) =>
  Array.match(tasks, {
    onEmpty: () => "There are none: this is the first plan.",
    onNonEmpty: (some) =>
      Array.join(
        Array.map(
          some,
          (task) => `- \`${task.id}\`: ${task.title} (builds ${idList(task.specSections)})`,
        ),
        "\n",
      ),
  });

/** The categories of the config, one bullet each, for the `tasks` and `splitTask` prompts. */
const categoryTable = (categories: ReadonlyArray<Category>) =>
  Array.join(
    Array.map(categories, ({ description, name }) => `- \`${name}\`: ${description}`),
    "\n",
  );

/** The models of the config's table, one bullet each, for the `tasks` prompt. */
const modelTable = (models: Readonly<Record<string, string>>) =>
  Array.join(
    Array.map(Record.toEntries(models), ([name, use]) => `- \`${name}\`: ${use}`),
    "\n",
  );

/**
 * The paragraphs a part run adds to the `sections` and `tasks` prompts, after a blank line, or
 * nothing for a run of the whole PRD.
 */
const partRule = (prompt: string, template: string, part: PartIds | undefined) =>
  Option.match(Option.fromUndefinedOr(part), {
    onNone: () => Effect.succeed(""),
    onSome: (ids) =>
      fillPrompt(prompt, template, { part: idList(idsOfPart(ids)) }).pipe(
        Effect.map((rule) => `\n\n${String.trim(rule)}`),
      ),
  });

/**
 * Reads the prompt files and the worked example once, then makes the prompts. `models` is the
 * config's `judge.models` table and `categories` its `categories` list, which the `tasks` and
 * `splitTask` prompts show the model.
 */
export const loadPrompts = Effect.fn("loadPrompts")(function* (
  models: Readonly<Record<string, string>>,
  categories: ReadonlyArray<Category>,
) {
  const [
    retry,
    spec,
    sections,
    tasks,
    partSections,
    partTasks,
    example,
    splitSection,
    splitOpening,
    splitTask,
    index,
    statements,
  ] = yield* Effect.all(
    [
      readText("retry", promptUrl("retry")),
      readText("spec", promptUrl("spec")),
      readText("sections", promptUrl("sections")),
      readText("tasks", promptUrl("tasks")),
      readText("part-sections", promptUrl("part-sections")),
      readText("part-tasks", promptUrl("part-tasks")),
      readText("spec example", exampleUrl),
      readText("split-section", promptUrl("split-section")),
      readText("split-task-opening", promptUrl("split-task-opening")),
      readText("split-task", promptUrl("split-task")),
      readText("index", promptUrl("index")),
      readText("statements", promptUrl("statements")),
    ],
    { concurrency: "unbounded" },
  );
  return {
    retry: (error) => fillPrompt("retry", retry, { error }),
    spec: (prd) => fillPrompt("spec", spec, { example, prd }),
    sections: (prd, specText, prdSections, rewrite, part?: PartIds) =>
      Effect.gen(function* () {
        return yield* fillPrompt("sections", sections, {
          part: yield* partRule("part-sections", partSections, part),
          prd,
          rewrite: idList(rewrite),
          sections: idList(prdSections),
          spec: specText,
        });
      }),
    tasks: (prd, specText, specSections, existing, part?: PartIds) =>
      Effect.gen(function* () {
        return yield* fillPrompt("tasks", tasks, {
          categories: categoryTable(categories),
          existing: existingList(existing),
          models: modelTable(models),
          part: yield* partRule("part-tasks", partTasks, part),
          prd,
          sections: idList(specSections),
          spec: specText,
        });
      }),
    splitOpening: (specText) =>
      fillPrompt("split-task-opening", splitOpening, {
        categories: categoryTable(categories),
        models: modelTable(models),
        spec: specText,
      }),
    splitTask: (draft, reason) => fillPrompt("split-task", splitTask, { draft, reason }),
    splitSection: (section, reason) =>
      fillPrompt("split-section", splitSection, { reason, section }),
    index: (section) =>
      fillPrompt("index", index, { body: section.body, id: section.id, title: section.title }),
    statements: (prd, targets) =>
      fillPrompt("statements", statements, { prd, targets: idList(targets) }),
  } satisfies Prompts;
});

/** The failures that mean the reply came back but did not decode, which a second try can fix. */
const isDecodeFailure = (error: AiError.AiError) =>
  Predicate.or(
    Predicate.isTagged("StructuredOutputError"),
    Predicate.isTagged("InvalidOutputError"),
  )(error.reason);

const failed =
  (call: PlannerError["call"]) =>
  (error: AiError.AiError | PlannerError | PromptError | Schema.SchemaError) =>
    Schema.is(PlannerError)(error) ? error : new PlannerError({ call, reason: error.message });

/**
 * Logs one line when a model call ends: which call it was, how long it took, the sizes in
 * characters of the turn it sent and of the reply, and whether it failed. A retry is a model call
 * of its own, a follow-up turn of the same chat, so it has its own line. The line goes where the program's logger sends it: stderr for `cairn`.
 */
const timed =
  (call: PlannerError["call"]) =>
  <A extends { readonly text: string }, E, R>(prompt: string, ask: Effect.Effect<A, E, R>) =>
    Effect.timed(Effect.result(ask)).pipe(
      Effect.tap(([elapsed, reply]) =>
        Effect.logInfo("Planner call").pipe(
          Effect.annotateLogs({
            call,
            outcome: Result.isSuccess(reply) ? "ok" : "failed",
            promptChars: String.length(prompt),
            replyChars: Result.isSuccess(reply) ? String.length(reply.success.text) : 0,
            seconds: Number.round(Duration.toSeconds(elapsed), 1),
          }),
        ),
      ),
      Effect.flatMap(([, reply]) => Effect.fromResult(reply)),
    );

/**
 * The turn of a structured reply that did not decode, which `Chat.generateObject` leaves out of
 * its history: the prompt, and the refused reply when the error kept its text. A reply with no text
 * is left out, because a provider such as Anthropic refuses an assistant turn whose text is blank.
 */
const refusedTurn = (prompt: string, error: AiError.AiError) =>
  Prompt.make(
    Array.prepend(
      Match.value(error.reason).pipe(
        Match.tag("StructuredOutputError", (reason) =>
          String.isNonEmpty(String.trim(reason.responseText))
            ? [{ content: reason.responseText, role: "assistant" as const }]
            : [],
        ),
        Match.orElse(() => []),
      ),
      { content: prompt, role: "user" as const },
    ),
  );

/** The Mermaid blocks of `markdown` that do not draw, each with its parser error and the section it is in. */
const undrawnIn = (markdown: string) => {
  const sections = sectionsOf(markdown);
  return Array.filterMap(mermaidBlocksOf(markdown), (block) =>
    Option.match(drawsOf(block.source), {
      onNone: () => Result.failVoid,
      onSome: (error) =>
        Result.succeed({
          block,
          error,
          section: Array.findLast(sections, (section) => section.line <= block.start + 1).pipe(
            Option.match({
              onNone: () => "the spec",
              onSome: (found) =>
                Option.getOrElse(Option.fromUndefinedOr(found.id), () => `"${found.title}"`),
            }),
          ),
        }),
    }),
  );
};

/**
 * Checks that every Mermaid block of `markdown` draws. A block that does not is sent back once:
 * `again` is given the errors and returns the document written again. A block that still does not
 * draw is removed, and a line says which section it was in.
 */
export const drawnOf = <E, R>(
  markdown: string,
  again: (errors: string) => Effect.Effect<string, E, R>,
) =>
  Effect.gen(function* () {
    const undrawn = undrawnIn(markdown);
    if (!Array.isReadonlyArrayNonEmpty(undrawn)) {
      return markdown;
    }
    const second = yield* again(
      Array.join(
        Array.map(
          undrawn,
          ({ block, error, section }) =>
            `The Mermaid diagram in ${section} does not draw: ${error}\n\n\`\`\`mermaid\n${block.source}\n\`\`\``,
        ),
        "\n\n",
      ),
    );
    const left = undrawnIn(second);
    yield* Effect.forEach(
      left,
      ({ error, section }) =>
        Console.log(
          `Warning: left out a Mermaid diagram in ${section}, which does not draw: ${error}`,
        ),
      { discard: true },
    );
    return withoutMermaidBlocks(
      second,
      Array.map(left, ({ block }) => block),
    );
  });

/**
 * Plans with a language model. The calls here are `spec`, `sections`, `tasks`, `splitSection`,
 * `splitTask`, `index` and `statements`.
 */
export class Planner extends Context.Service<
  Planner,
  {
    /** The spec markdown for a PRD. */
    readonly spec: (prd: string) => Effect.Effect<string, PlannerError>;
    /**
     * Markdown for new spec sections that implement `prdSections`, written to sit in `spec`, each
     * naming the section it goes under. `rewrite` names sections of `spec` to write again under
     * the same ID. The spec section leaves open how a rewrite is asked for; this is the fourth
     * argument. `part` is the part of the PRD a `cairn plan <id>` run plans, and is absent on a run
     * of the whole PRD. With it, a section whose `Implements`, `Defers` or `Context` names an
     * ID outside it is sent back once with the error, and then fails with a `PlannerError`.
     */
    readonly sections: (
      prd: string,
      spec: string,
      prdSections: ReadonlyArray<PrdSectionId>,
      rewrite: ReadonlyArray<SpecSectionId>,
      part?: PartIds,
    ) => Effect.Effect<string, PlannerError>;
    /**
     * The task drafts for `specSections` of the spec. `existing` is the tasks the manifest already
     * has, which a draft may depend on by ID; it is empty on a first plan. With `part`, a draft
     * whose `prdSections` are not all in it, or whose `specSections` are not all in
     * `specSections`, is sent back once with the error, and then fails with a `PlannerError`.
     */
    readonly tasks: (
      prd: string,
      spec: string,
      specSections: ReadonlyArray<SpecSectionId>,
      existing: ReadonlyArray<ManifestTask>,
      part?: PartIds,
    ) => Effect.Effect<ReadonlyArray<TaskDraft>, PlannerError>;
    /** Markdown for two or more sections that replace `section`, because of `reason`. */
    readonly splitSection: (section: string, reason: string) => Effect.Effect<string, PlannerError>;
    /**
     * The conversation the `splitTask` calls of one round share: it opens with `spec`, the
     * categories and the models as one system message, and holds nothing else. Each split runs in
     * a `branch` of it (`chat.ts`), so concurrent splits never see each other's turns and the
     * trunk keeps only the opening.
     */
    readonly splitTrunk: (spec: string) => Effect.Effect<Chat.Chat, PlannerError>;
    /**
     * Two or more drafts that together cover `draft`, because of `reason`, asked as the next turn
     * of the provided `Chat`, which `splitTrunk` opened with the spec. A retry is a turn of that
     * chat too, so give each split its own `branch` of the trunk.
     */
    readonly splitTask: (
      draft: TaskDraft,
      reason: string,
    ) => Effect.Effect<ReadonlyArray<TaskDraft>, PlannerError, Chat.Chat>;
    /** The prose fields of the section's entry in `spec.json`. */
    readonly index: (section: IndexTarget) => Effect.Effect<IndexProse, PlannerError>;
    /**
     * Drafts of "Done when" statements for `targets`, sections and list items of `prd` that have
     * none (`spec.planning.done-when.asking-the-person`). A target the model describes with no
     * drafts has nothing to build; a reply about a part that was not asked about is refused.
     */
    readonly statements: (
      prd: string,
      targets: ReadonlyArray<PrdSectionId>,
    ) => Effect.Effect<ReadonlyArray<Drafted>, PlannerError>;
  }
>()("@cairn/cli/Planner") {
  /**
   * Plans with whichever `LanguageModel` the environment provides, and prompts that show the
   * model `config.judge.models`. It reads the prompt files when it is built, so a missing or
   * broken file fails there, before any call.
   */
  static readonly layerWith = (config: Pick<Config, "categories" | "judge">) =>
    Layer.effect(
      Planner,
      Effect.gen(function* () {
        const model = yield* LanguageModel.LanguageModel;
        const provided = yield* Effect.serviceOption(SmallLanguageModel);
        const small = Option.getOrElse(provided, () => model);
        /** Runs a model call with the model of `call`: the small one for a small call. */
        const using = (call: PlannerError["call"]) =>
          Effect.provideService(LanguageModel.LanguageModel, isSmallCall(call) ? small : model);
        const prompts = yield* loadPrompts(config.judge.models, config.categories);
        const knownCategories = inCategories(config.categories);

        /** One turn of `chat` that asks for text. The turn and the reply join the chat's history. */
        const textIn = (call: PlannerError["call"], chat: Chat.Chat) => (prompt: string) =>
          timed(call)(prompt, chat.generateText({ prompt }).pipe(using(call))).pipe(
            Effect.map((response) => response.text),
          );

        /** Asks again in `chat` after its last reply was refused; the follow-up carries only why. */
        const againIn = (call: PlannerError["call"], chat: Chat.Chat) => (errors: string) =>
          prompts.retry(errors).pipe(Effect.flatMap(textIn(call, chat)));

        const spec = Effect.fn("Planner.spec")(
          function* (prd: string) {
            const chat = yield* Chat.empty;
            const prompt = yield* prompts.spec(prd);
            const reply = yield* textIn("spec", chat)(prompt);
            return yield* drawnOf(reply, againIn("spec", chat));
          },
          Effect.mapError(failed("spec")),
        );

        /** A `sections` turn of `chat`, whose Mermaid blocks that do not draw go back once in the same chat. */
        const drawnIn = (chat: Chat.Chat) => (prompt: string) =>
          textIn(
            "sections",
            chat,
          )(prompt).pipe(Effect.flatMap((reply) => drawnOf(reply, againIn("sections", chat))));

        const sections = Effect.fn("Planner.sections")(
          function* (
            prd: string,
            specText: string,
            prdSections: ReadonlyArray<PrdSectionId>,
            rewrite: ReadonlyArray<SpecSectionId>,
            part?: PartIds,
          ) {
            const chat = yield* Chat.empty;
            const prompt = yield* prompts.sections(prd, specText, prdSections, rewrite, part);
            const written = yield* drawnIn(chat)(prompt);
            const outsideIn = (markdown: string) =>
              Option.match(Option.fromUndefinedOr(part), {
                onNone: () => Array.empty<string>(),
                onSome: (ids) => outsidePartIn(ids, markdown),
              });
            const outside = outsideIn(written);
            if (!Array.isReadonlyArrayNonEmpty(outside)) {
              return written;
            }
            const again = yield* prompts.retry(Array.join(outside, "\n"));
            const second = yield* drawnIn(chat)(again);
            const left = outsideIn(second);
            return Array.isReadonlyArrayNonEmpty(left)
              ? yield* new PlannerError({ call: "sections", reason: Array.join(left, "\n") })
              : second;
          },
          Effect.mapError(failed("sections")),
        );

        // `generateObject` decodes the reply through its schema, so a reply that does not decode
        // fails with a decode failure we can tell from a transport one. That lets each call
        // decide to ask once more, in the same chat, with the decode error as the follow-up turn.
        // A chat adds a turn to its history only when the reply decodes, so the turn and the
        // refused reply are added here first, and the model sees what it is asked to fix.
        const withRetry = <A>(
          chat: Chat.Chat,
          prompt: string,
          ask: (chat: Chat.Chat) => (prompt: string) => Effect.Effect<A, AiError.AiError>,
        ) =>
          ask(chat)(prompt).pipe(
            Effect.catchIf(isDecodeFailure, (error) =>
              Ref.update(chat.history, (history) =>
                Prompt.concat(history, refusedTurn(prompt, error)),
              ).pipe(Effect.andThen(prompts.retry(error.message)), Effect.flatMap(ask(chat))),
            ),
          );

        const draftsFor = (schema: typeof TaskDrafts) => (chat: Chat.Chat) => (prompt: string) =>
          timed("tasks")(
            prompt,
            chat.generateObject({ objectName: "TaskDrafts", prompt, schema }).pipe(using("tasks")),
          ).pipe(Effect.map((response) => response.value.drafts));

        const tasks = Effect.fn("Planner.tasks")(
          function* (
            prd: string,
            specText: string,
            specSections: ReadonlyArray<SpecSectionId>,
            existing: ReadonlyArray<ManifestTask>,
            part?: PartIds,
          ) {
            const chat = yield* Chat.empty;
            const prompt = yield* prompts.tasks(prd, specText, specSections, existing, part);
            return yield* withRetry(
              chat,
              prompt,
              draftsFor(
                Option.match(Option.fromUndefinedOr(part), {
                  onNone: () => TaskDrafts.check(knownCategories),
                  onSome: (ids) => draftsInPart(ids, specSections).check(knownCategories),
                }),
              ),
            );
          },
          Effect.mapError(failed("tasks")),
        );

        const splitSection = Effect.fn("Planner.splitSection")(
          function* (section: string, reason: string) {
            const chat = yield* Chat.empty;
            const prompt = yield* prompts.splitSection(section, reason);
            return yield* textIn("splitSection", chat)(prompt);
          },
          Effect.mapError(failed("splitSection")),
        );

        const splitTrunk = Effect.fn("Planner.splitTrunk")(
          function* (specText: string) {
            const opening = yield* prompts.splitOpening(specText);
            return yield* Chat.fromPrompt([{ content: opening, role: "system" }]);
          },
          Effect.mapError(failed("splitTask")),
        );

        const splitDraftsFor = (chat: Chat.Chat) => (prompt: string) =>
          timed("splitTask")(
            prompt,
            chat
              .generateObject({
                objectName: "SplitDrafts",
                prompt,
                schema: SplitDrafts.check(knownCategories),
              })
              .pipe(using("splitTask")),
          ).pipe(Effect.map((response) => response.value.drafts));

        const splitTask = Effect.fn("Planner.splitTask")(
          function* (draft: TaskDraft, reason: string) {
            const chat = yield* Chat.Chat;
            const draftJson = yield* Schema.encodeEffect(DraftJson)(draft);
            const prompt = yield* prompts.splitTask(draftJson, reason);
            return yield* withRetry(chat, prompt, splitDraftsFor);
          },
          Effect.mapError(failed("splitTask")),
        );

        const index = Effect.fn("Planner.index")(
          function* (section: IndexTarget) {
            const chat = yield* Chat.empty;
            const prompt = yield* prompts.index(section);
            const proseFor = (own: Chat.Chat) => (text: string) =>
              timed("index")(
                text,
                own
                  .generateObject({
                    objectName: "IndexProse",
                    prompt: text,
                    schema: indexProseOf(section.id),
                  })
                  .pipe(using("index")),
              ).pipe(Effect.map((response) => response.value));
            return yield* withRetry(chat, prompt, proseFor);
          },
          Effect.mapError(failed("index")),
        );

        const statements = Effect.fn("Planner.statements")(
          function* (prd: string, targets: ReadonlyArray<PrdSectionId>) {
            const chat = yield* Chat.empty;
            const prompt = yield* prompts.statements(prd, targets);
            const draftsOf = (own: Chat.Chat) => (text: string) =>
              timed("statements")(
                text,
                own
                  .generateObject({
                    objectName: "StatementDrafts",
                    prompt: text,
                    schema: statementDraftsOf(targets),
                  })
                  .pipe(using("statements")),
              ).pipe(Effect.map((response) => response.value.statements));
            return yield* withRetry(chat, prompt, draftsOf);
          },
          Effect.mapError(failed("statements")),
        );

        return Planner.of({
          index,
          sections,
          spec,
          splitSection,
          splitTask,
          splitTrunk,
          statements,
          tasks,
        });
      }),
    );

  /** `layerWith` the default config's model table. */
  static readonly layer = Planner.layerWith(defaultConfig);
}
