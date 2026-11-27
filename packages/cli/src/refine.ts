import { JudgmentTarget, RateAnswer, SpecSectionId, TaskId } from "@cairn/contract";
import type { Config, Judgment, Reasoning, Section, TaskDraft } from "@cairn/contract";
import {
  StackJudgingInput,
  assignSectionIds,
  routeOf,
  sectionIdsOf,
  sectionsOf,
} from "@cairn/core";
import type {
  Answer,
  Route,
  SectionJudgingInput,
  SectionText,
  TaskJudgingInput,
} from "@cairn/core";
import {
  Array,
  Effect,
  HashMap,
  HashSet,
  Number,
  Option,
  Ref,
  Result,
  Schema,
  String,
  Struct,
  pipe,
} from "effect";
import { Chat } from "effect/ai";

import { branch } from "./chat.ts";
import { Judge } from "./judge.ts";
import type { JudgeError } from "./judge.ts";
import { Planner } from "./planner.ts";
import type { PlannerError } from "./planner.ts";

/** What `refine` reads (`spec.judging.checkpoints`). */
export interface RefineInput {
  readonly prd: string;
  readonly spec: string;
  readonly drafts: ReadonlyArray<TaskDraft>;
  /** `Planner.spec` wrote the whole spec in this run, so every section is judged. */
  readonly specGenerated: boolean;
  /**
   * When planning again, the sections this run wrote or rewrote: the ones judged when
   * `specGenerated` is false. Ignored when it is true.
   */
  readonly written: ReadonlyArray<SpecSectionId>;
}

/**
 * What `refine` returns: the spec and drafts after the checkpoints, and every judgment it made.
 * A judgment with `action: "split"` or `"routed"` is behind a change; the rest only report.
 * Draft judgments name the draft by title, since a draft has no task ID yet.
 */
export interface Refined {
  readonly spec: string;
  readonly drafts: ReadonlyArray<TaskDraft>;
  readonly judgments: ReadonlyArray<Judgment>;
}

/** How many split requests are in flight at once, as many as `Judge` sends. */
const CONCURRENT_SPLITS = 4;

/**
 * `Judge.judge` always judges a stack too. The stack checkpoint runs in `cairn plan` after
 * `stackOf`, so `refine` gives it this placeholder and drops what comes back. Each run keeps the
 * stack judgments from its first call as `previous`, so the stack is asked once per run.
 */
const PLACEHOLDER_STACK: StackJudgingInput = {
  feature: StackJudgingInput.fields.feature.make("refine"),
  goal: "",
  prdSections: [],
  tasks: [],
};

const isSpecSectionId = Schema.is(SpecSectionId);
const isRate = Schema.is(RateAnswer);

/** The sections that have an ID, keyed by it as a plain string, so a PRD or spec ID finds it. */
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
  Array.getSomes(
    Array.map(ids, (id) =>
      Option.map(HashMap.get(sections, id), ({ body, title }) => ({ body, title })),
    ),
  );

/** A spec section as `inputsOf` gives it, so the hash matches what `cairn judge` computes. */
const sectionInputOf =
  (prd: HashMap.HashMap<string, Section>) =>
  (section: Section): SectionJudgingInput => ({
    body: section.body,
    files: section.keys.files,
    implements: textsOf(prd, section.keys.implements),
    title: section.title,
  });

/** A draft as a task input. Its `dependsOn` already holds titles, or IDs of planned tasks. */
const draftInputOf = (
  prd: HashMap.HashMap<string, Section>,
  spec: HashMap.HashMap<string, Section>,
  draft: TaskDraft,
): TaskJudgingInput => ({
  dependsOn: draft.dependsOn,
  files: draft.files,
  prdSections: textsOf(prd, draft.prdSections),
  specSections: textsOf(spec, draft.specSections),
  title: draft.title,
});

/** The `size` judgment among `judgments` when it is `too_large` with confidence enough to act. */
const confidentlyTooLarge = (
  judgments: ReadonlyArray<Judgment>,
  minConfidence: number,
): Option.Option<Judgment> =>
  Array.findFirst(
    judgments,
    (judgment) =>
      judgment.question === "size" &&
      isRate(judgment.answer) &&
      judgment.answer.label === "too_large" &&
      Option.exists(
        Option.fromUndefinedOr(judgment.answer.confidence),
        Number.isGreaterThanOrEqualTo(minConfidence),
      ),
  );

/** `judgments` with the `size` one given `action` and `note` after its message. */
const notedSize = (
  judgments: ReadonlyArray<Judgment>,
  action: "none" | "split",
  note: string,
): ReadonlyArray<Judgment> =>
  Array.map(judgments, (judgment) =>
    judgment.question === "size"
      ? Struct.evolve(judgment, {
          action: (): Judgment["action"] => action,
          message: (message) => `${message}; ${note}`,
        })
      : judgment,
  );

const quoted = (items: ReadonlyArray<string>) =>
  Array.join(
    Array.map(items, (item) => `"${item}"`),
    ", ",
  );

/** The lines without the blank ones at the end. */
const withoutTrailingBlanks = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.reverse(Array.dropWhile(Array.reverse(lines), (line) => String.isEmpty(String.trim(line))));

/** A heading line without its `{#id}`. */
const withoutId = String.replace(/[ \t]*\{#[^}\s]+\}[ \t]*$/u, "");

/** Where a section's own text sits in the spec's lines: from its heading to the next heading. */
interface Span {
  readonly end: number;
  readonly section: Section;
  readonly start: number;
}

const spanOf = (spec: string, id: string): Option.Option<Span> => {
  const sections = sectionsOf(spec);
  return pipe(
    Array.findFirstIndex(sections, (section) => section.id === id),
    Option.flatMap((index) =>
      Option.map(Array.get(sections, index), (section) => ({
        end: Option.getOrElse(
          Option.map(Array.get(sections, index + 1), (next) => next.line - 1),
          () => Array.length(String.split(spec, "\n")),
        ),
        section,
        start: section.line - 1,
      })),
    ),
  );
};

/** A section's own markdown, heading included, as `Planner.splitSection` reads it. */
const markdownOf = (spec: string, { end, start }: Span) =>
  Array.join(
    withoutTrailingBlanks(Array.take(Array.drop(String.split(spec, "\n"), start), end - start)),
    "\n",
  );

/**
 * The spec with section `id` replaced by `reply`, the sections `Planner.splitSection` wrote, and
 * the IDs of those sections; or why the split is discarded. A reply heading whose ID the spec
 * already has loses it, and every heading without one gets one from `assignSectionIds`. The
 * split is discarded when the reply has no section, or a section in it drops one of the
 * original's `Implements`, inherited ones included.
 */
const splicedSection = (
  spec: string,
  id: SpecSectionId,
  reply: string,
): Result.Result<{ readonly added: ReadonlyArray<SpecSectionId>; readonly spec: string }, string> =>
  Option.match(spanOf(spec, id), {
    onNone: () => Result.fail(`${id} is no longer in the spec`),
    onSome: ({ end, section: original, start }) => {
      const lines = String.split(spec, "\n");
      const taken = HashSet.fromIterable(sectionIdsOf(spec));
      const clashing = HashSet.fromIterable(
        Array.getSomes(
          Array.map(sectionsOf(reply), (heading) =>
            pipe(
              Option.fromUndefinedOr(heading.id),
              Option.filter((headingId) => HashSet.has(taken, headingId)),
              Option.map(() => heading.line - 1),
            ),
          ),
        ),
      );
      const replyLines = withoutTrailingBlanks(
        Array.map(String.split(reply, "\n"), (line, index) =>
          HashSet.has(clashing, index) ? withoutId(line) : line,
        ),
      );
      const before = Array.take(lines, start);
      const after = Array.drop(lines, end);
      const gap = Array.isReadonlyArrayNonEmpty(after) ? [""] : [];
      // IDs are assigned with the whole spec around the reply, so they nest under its parent and
      // stay unique; only the reply's lines take them, so no other heading changes.
      const named = Array.take(
        Array.drop(
          String.split(
            assignSectionIds(
              Array.join(Array.flatten([before, replyLines, gap, after]), "\n"),
              "spec",
            ).markdown,
            "\n",
          ),
          start,
        ),
        Array.length(replyLines),
      );
      const markdown = Array.join(Array.flatten([before, named, gap, after]), "\n");
      // `assignSectionIds` keeps the line count, so the reply's sections are the ones in its lines.
      const replacements = Array.filter(
        sectionsOf(markdown),
        (heading) => heading.line > start && heading.line <= start + Array.length(replyLines),
      );
      const dropped = Array.filterMap(replacements, (replacement) =>
        pipe(
          Array.filter(
            original.keys.implements,
            (prdId) => !Array.contains(replacement.keys.implements, prdId),
          ),
          Array.match({
            onEmpty: () => Result.failVoid,
            onNonEmpty: (missing) =>
              Result.succeed(
                `${Option.getOrElse(Option.fromUndefinedOr(replacement.id), () => replacement.title)} drops Implements ${Array.join(missing, ", ")}`,
              ),
          }),
        ),
      );
      return Array.isReadonlyArrayEmpty(replacements)
        ? Result.fail("the reply has no sections")
        : Array.isReadonlyArrayNonEmpty(dropped)
          ? Result.fail(Array.join(dropped, "; "))
          : Result.succeed({
              added: Array.getSomes(
                Array.map(replacements, (replacement) =>
                  Option.filter(Option.fromUndefinedOr(replacement.id), isSpecSectionId),
                ),
              ),
              spec: markdown,
            });
    },
  });

/**
 * Why a split of `draft` into `replacements` is discarded: a spec section or a file of the
 * draft that none of them keeps. None when they cover it.
 */
const droppedBy = (
  draft: TaskDraft,
  replacements: ReadonlyArray<TaskDraft>,
): Option.Option<string> => {
  const missing = (field: (draft: TaskDraft) => ReadonlyArray<string>) =>
    Array.filter(
      field(draft),
      (item) =>
        !Array.some(replacements, (replacement) => Array.contains(field(replacement), item)),
    );
  const reasons = Array.flatten([
    Array.map(missing(Struct.get("specSections")), (id) => `spec section ${id}`),
    Array.map(missing(Struct.get("files")), (path) => `file ${path}`),
  ]);
  return Array.match(reasons, {
    onEmpty: () => Option.none(),
    onNonEmpty: (some) => Option.some(`it drops ${Array.join(some, ", ")}`),
  });
};

/**
 * `draft` with each dependency on a draft split this round replaced by that draft's
 * replacements. `origin` is the draft it replaces, if it is a replacement: it drops a dependency
 * on that one, which would make the replacements depend on each other.
 */
const rewired = (
  draft: TaskDraft,
  splits: HashMap.HashMap<string, ReadonlyArray<string>>,
  origin: Option.Option<string>,
): TaskDraft =>
  Struct.evolve(draft, {
    dependsOn: (dependsOn) =>
      Array.dedupe(
        Array.flatMap(dependsOn, (title) =>
          Option.contains(origin, title)
            ? []
            : Option.match(HashMap.get(splits, title), {
                onNone: () => [title],
                onSome: (titles) => Array.filter(titles, (own) => own !== draft.title),
              }),
        ),
      ),
  });

/**
 * `specSections` with each section a split replaced named by its replacements, in the order the
 * splits happened, so a replacement split again is followed to its own replacements.
 */
const renamed = (
  specSections: TaskDraft["specSections"],
  renames: ReadonlyArray<readonly [string, Array.NonEmptyReadonlyArray<SpecSectionId>]>,
): TaskDraft["specSections"] =>
  Array.reduce(renames, specSections, (ids, [from, to]) =>
    Array.dedupe(Array.flatMap(ids, (id) => (id === from ? to : Array.make(id)))),
  );

/** A routing judgment with the verdict and message `routeOf` gave, `routed` when it changed. */
const routedJudgment = (judgment: Judgment, route: Route<string>, before: string): Judgment => {
  const after = Option.getOrElse(route.value, () => before);
  const changed = after !== before;
  return Struct.evolve(judgment, {
    action: (): Judgment["action"] => (changed ? "routed" : "none"),
    message: () => (changed ? `${route.message}; routed ${before} to ${after}` : route.message),
    verdict: () => route.verdict,
  });
};

/** What a `model` question the judge did not ask, because there is one model, answers. */
const NOT_ASKED: Answer = {
  description: "judge.models names fewer than two models, so the judge was not asked",
  unanswered: "Missing",
};

/** One draft with the judgments of the round it was last judged in. */
interface Judged {
  readonly draft: TaskDraft;
  readonly judgments: ReadonlyArray<Judgment>;
}

/**
 * The routing checkpoint for one draft: its `model` and `reasoning` answers go through `routeOf`.
 * A confident answer replaces the planner's value; otherwise the planner's value stays.
 */
const routed = ({ draft, judgments }: Judged, config: Pick<Config, "judge">): Judged => {
  const answerTo = (question: "model" | "reasoning") =>
    Option.getOrElse(
      Option.map(
        Array.findFirst(judgments, (judgment) => judgment.question === question),
        Struct.get("answer"),
      ),
      () => NOT_ASKED,
    );
  const route = routeOf(
    { model: answerTo("model"), reasoning: answerTo("reasoning") },
    draft,
    config.judge,
  );
  return {
    draft: Struct.evolve(draft, {
      model: (model) => Option.getOrElse(route.model.value, () => model),
      reasoning: (reasoning): Reasoning => Option.getOrElse(route.reasoning.value, () => reasoning),
    }),
    judgments: Array.map(judgments, (judgment) =>
      judgment.question === "model"
        ? routedJudgment(judgment, route.model, draft.model)
        : judgment.question === "reasoning"
          ? routedJudgment(judgment, route.reasoning, draft.reasoning)
          : judgment,
    ),
  };
};

/** The judgments of one section. */
const ofSection = (judgments: ReadonlyArray<Judgment>, id: string) =>
  Array.filter(
    judgments,
    (judgment) => judgment.target.kind === "section" && judgment.target.id === id,
  );

/** The judgments of one draft, which a judgment names by title. */
const ofDraft = (judgments: ReadonlyArray<Judgment>, title: string) =>
  Array.filter(
    judgments,
    (judgment) => judgment.target.kind === "draft" && judgment.target.title === title,
  );

/**
 * The first three checkpoints (`spec.judging.checkpoints`) with whichever `Judge` and `Planner`
 * the environment provides. A round judges what is new and splits what is confidently
 * `too_large`; what a split writes is judged in the next round. Steps 1 and 2 each run at most
 * `judge.maxRounds` rounds, so nothing is split in the last one: what is still too large there
 * keeps its `flag`.
 *
 * 1. Sections: every section with a spec ID when `specGenerated`, otherwise those in `written`.
 *    A section marked `<!-- human -->` is judged and never split. `faithful`, `inScope` and
 *    `buildable` are reported and never acted on.
 * 2. Task size: every draft, then the drafts each split writes. `matches` and `inScope` are
 *    reported and never acted on.
 * 3. Routing: every draft's `model` and `reasoning` answers, from the round it was judged in.
 */
export const refineWith = Effect.fn("refineWith")(function* (
  input: RefineInput,
  config: Pick<Config, "judge">,
) {
  const judge = yield* Judge;
  const planner = yield* Planner;
  const stack = yield* Ref.make<ReadonlyArray<Judgment>>([]);
  const { maxRounds, minConfidence } = config.judge;
  const prdById = byId(sectionsOf(input.prd));

  /** Judges sections and drafts as round `round`. A draft's judgments name it by title. */
  const judged = Effect.fn("refine.judged")(function* (
    round: number,
    sections: ReadonlyArray<{ readonly id: SpecSectionId; readonly input: SectionJudgingInput }>,
    drafts: ReadonlyArray<{ readonly input: TaskJudgingInput; readonly title: string }>,
  ) {
    const ids = Array.map(drafts, (_, index) => TaskId.make(`draft-${index + 1}`));
    const titles = HashMap.fromIterable(
      Array.zipWith(ids, drafts, (id, { title }) => [id, title] as const),
    );
    const result = yield* judge.judge(
      {
        sections,
        stack: PLACEHOLDER_STACK,
        tasks: Array.zipWith(ids, drafts, (id, draft) => ({ id, input: draft.input })),
      },
      { judgments: yield* Ref.get(stack), model: config.judge.model, version: 1 },
    );
    yield* Ref.set(
      stack,
      Array.filter(result.judgments, (judgment) => judgment.target.kind === "stack"),
    );
    const inRound = (judgment: Judgment, target: JudgmentTarget) =>
      Result.succeed(Struct.evolve(judgment, { round: () => round, target: () => target }));
    return Array.filterMap(result.judgments, (judgment) =>
      JudgmentTarget.match(judgment.target, {
        draft: () => Result.failVoid,
        section: (target) => inRound(judgment, target),
        stack: () => Result.failVoid,
        task: ({ id }) =>
          Option.match(HashMap.get(titles, id), {
            onNone: () => Result.failVoid,
            onSome: (title) => inRound(judgment, { kind: "draft", title }),
          }),
      }),
    );
  });

  interface Sections {
    readonly judgments: ReadonlyArray<Judgment>;
    /** Each section a split replaced, with the IDs of its replacements, in the order of the splits. */
    readonly renames: ReadonlyArray<readonly [string, Array.NonEmptyReadonlyArray<SpecSectionId>]>;
    readonly spec: string;
  }

  /** Step 1 from round `round`, judging the sections `pending` names. */
  const sectionRounds = (
    round: number,
    state: Sections,
    pending: ReadonlyArray<string>,
  ): Effect.Effect<Sections, JudgeError | PlannerError> =>
    Effect.gen(function* () {
      const wanted = HashSet.fromIterable(pending);
      const targets = Array.getSomes(
        Array.map(sectionsOf(state.spec), (section) =>
          pipe(
            Option.fromUndefinedOr(section.id),
            Option.filter(isSpecSectionId),
            Option.filter((id) => HashSet.has(wanted, id)),
            Option.map((id) => ({ id, section })),
          ),
        ),
      );
      if (Array.isReadonlyArrayEmpty(targets)) {
        return state;
      }
      const toInput = sectionInputOf(prdById);
      const judgments = yield* judged(
        round,
        Array.map(targets, ({ id, section }) => ({ id, input: toInput(section) })),
        [],
      );
      const outcomes = yield* Effect.forEach(
        targets,
        ({ id, section }) => {
          const own = ofSection(judgments, id);
          return Option.match(confidentlyTooLarge(own, minConfidence), {
            onNone: () => Effect.succeed({ id, own, reply: Option.none<string>() }),
            onSome: (size) =>
              section.human
                ? Effect.succeed({
                    id,
                    own: notedSize(own, "none", "not split: a person wrote or edited it"),
                    reply: Option.none<string>(),
                  })
                : round >= maxRounds
                  ? Effect.succeed({
                      id,
                      own: notedSize(own, "none", `not split: round ${round} is judge.maxRounds`),
                      reply: Option.none<string>(),
                    })
                  : Effect.map(
                      planner.splitSection(
                        Option.match(spanOf(state.spec, id), {
                          onNone: () => section.body,
                          onSome: (span) => markdownOf(state.spec, span),
                        }),
                        size.message,
                      ),
                      (reply) => ({ id, own, reply: Option.some(reply) }),
                    ),
          });
        },
        { concurrency: CONCURRENT_SPLITS },
      );
      const next = Array.reduce(
        outcomes,
        {
          added: Array.empty<SpecSectionId>(),
          judgments: state.judgments,
          renames: state.renames,
          spec: state.spec,
        },
        (current, { id, own, reply }) =>
          Option.match(reply, {
            onNone: () => Struct.evolve(current, { judgments: (all) => Array.appendAll(all, own) }),
            onSome: (markdown) =>
              Result.match(splicedSection(current.spec, id, markdown), {
                onFailure: (why) =>
                  Struct.evolve(current, {
                    judgments: (all) =>
                      Array.appendAll(
                        all,
                        notedSize(own, "none", `the split was discarded: ${why}`),
                      ),
                  }),
                onSuccess: ({ added, spec }) => ({
                  added: Array.appendAll(current.added, added),
                  judgments: Array.appendAll(
                    current.judgments,
                    notedSize(own, "split", `split into ${Array.join(added, ", ")}`),
                  ),
                  renames: Array.match(added, {
                    onEmpty: () => current.renames,
                    onNonEmpty: (ids) => Array.append(current.renames, [id, ids] as const),
                  }),
                  spec,
                }),
              }),
          }),
      );
      return yield* sectionRounds(
        round + 1,
        { judgments: next.judgments, renames: next.renames, spec: next.spec },
        next.added,
      );
    });

  interface Drafts {
    /** Every draft, each with the judgments of the round it was judged in. */
    readonly current: ReadonlyArray<Judged>;
    /** The judgments of drafts a split replaced. */
    readonly replaced: ReadonlyArray<Judgment>;
  }

  /** Step 2 from round `round`, judging the drafts `pending` names by title. */
  const draftRounds = (
    round: number,
    spec: string,
    state: Drafts,
    pending: ReadonlyArray<string>,
  ): Effect.Effect<Drafts, JudgeError | PlannerError> =>
    Effect.gen(function* () {
      const fresh = Array.filter(state.current, ({ draft }) =>
        Array.contains(pending, draft.title),
      );
      if (Array.isReadonlyArrayEmpty(fresh)) {
        return state;
      }
      const specById = byId(sectionsOf(spec));
      const judgments = yield* judged(
        round,
        [],
        Array.map(fresh, ({ draft }) => ({
          input: draftInputOf(prdById, specById, draft),
          title: draft.title,
        })),
      );
      // Every split of the round shares one opening, the spec, in a trunk chat, and asks in a
      // branch of it, so the splits running at once never share a history and the trunk keeps
      // only the opening.
      const outcomes = yield* Effect.forEach(
        fresh,
        ({ draft }) => {
          const own = ofDraft(judgments, draft.title);
          return Option.match(confidentlyTooLarge(own, minConfidence), {
            onNone: () =>
              Effect.succeed({ draft, own, split: Option.none<ReadonlyArray<TaskDraft>>() }),
            onSome: (size) =>
              round >= maxRounds
                ? Effect.succeed({
                    draft,
                    own: notedSize(own, "none", `not split: round ${round} is judge.maxRounds`),
                    split: Option.none<ReadonlyArray<TaskDraft>>(),
                  })
                : Effect.map(branch(planner.splitTask(draft, size.message)), (replacements) => ({
                    draft,
                    own,
                    split: Option.some(replacements),
                  })),
          });
        },
        { concurrency: CONCURRENT_SPLITS },
      ).pipe(Effect.provideServiceEffect(Chat.Chat, planner.splitTrunk(spec)));
      // Every split of the round is settled before any draft is rewired, so a replacement that
      // depends on another draft split in this round is pointed at that draft's replacements.
      const settled = Array.map(outcomes, ({ draft, own, split }) =>
        Option.match(split, {
          onNone: () => ({
            draft,
            judgments: own,
            replacements: Option.none<ReadonlyArray<TaskDraft>>(),
          }),
          onSome: (replacements) =>
            Option.match(droppedBy(draft, replacements), {
              onNone: () => ({
                draft,
                judgments: notedSize(
                  own,
                  "split",
                  `split into ${Array.length(replacements)} drafts: ${quoted(Array.map(replacements, Struct.get("title")))}`,
                ),
                replacements: Option.some(replacements),
              }),
              onSome: (why) => ({
                draft,
                judgments: notedSize(own, "none", `the split was discarded: ${why}`),
                replacements: Option.none<ReadonlyArray<TaskDraft>>(),
              }),
            }),
        }),
      );
      const byTitle = HashMap.fromIterable(
        Array.map(settled, (outcome) => [outcome.draft.title, outcome] as const),
      );
      const splits = HashMap.fromIterable(
        Array.getSomes(
          Array.map(settled, ({ draft, replacements }) =>
            Option.map(
              replacements,
              (some) => [draft.title, Array.map(some, Struct.get("title"))] as const,
            ),
          ),
        ),
      );
      const next = {
        added: Array.flatten(Array.fromIterable(HashMap.values(splits))),
        current: Array.flatMap(state.current, (entry): ReadonlyArray<Judged> => {
          const kept = (own: ReadonlyArray<Judgment>) => [
            { draft: rewired(entry.draft, splits, Option.none()), judgments: own },
          ];
          return Option.match(HashMap.get(byTitle, entry.draft.title), {
            onNone: () => kept(entry.judgments),
            onSome: (outcome) =>
              Option.match(outcome.replacements, {
                onNone: () => kept(outcome.judgments),
                onSome: (replacements) =>
                  Array.map(replacements, (replacement) => ({
                    draft: rewired(replacement, splits, Option.some(entry.draft.title)),
                    judgments: [],
                  })),
              }),
          });
        }),
        replaced: Array.appendAll(
          state.replaced,
          Array.flatMap(settled, (outcome) =>
            Option.isSome(outcome.replacements) ? outcome.judgments : [],
          ),
        ),
      };
      return yield* draftRounds(
        round + 1,
        spec,
        { current: next.current, replaced: next.replaced },
        next.added,
      );
    });

  const sections = yield* sectionRounds(
    1,
    { judgments: [], renames: [], spec: input.spec },
    input.specGenerated ? sectionIdsOf(input.spec) : input.written,
  );
  const drafts = yield* draftRounds(
    1,
    sections.spec,
    {
      // A draft names the sections it builds by ID, so a split section is named by its replacements.
      current: Array.map(input.drafts, (draft) => ({
        draft: Struct.evolve(draft, { specSections: (ids) => renamed(ids, sections.renames) }),
        judgments: [],
      })),
      replaced: [],
    },
    Array.map(input.drafts, Struct.get("title")),
  );
  const routedDrafts = Array.map(drafts.current, (entry) => routed(entry, config));
  return {
    drafts: Array.map(routedDrafts, Struct.get("draft")),
    judgments: Array.flatten([
      sections.judgments,
      drafts.replaced,
      Array.flatMap(routedDrafts, Struct.get("judgments")),
    ]),
    spec: sections.spec,
  } satisfies Refined;
});

/** The input as it came, with no judgments: what `refine` returns when it cannot judge. */
const unchanged = (input: RefineInput): Refined => ({
  drafts: input.drafts,
  judgments: [],
  spec: input.spec,
});

/**
 * `refineWith` over `Judge.live`. Without `TYPESAFE_API_KEY` or `judge.gatewayTokenEnv` the judge cannot be built, and the
 * input comes back unchanged with no judgments; the `Planner` is never called.
 */
export const refine = (input: RefineInput, config: Config) =>
  refineWith(input, config).pipe(
    Effect.provide(Judge.live(config)),
    Effect.catchTag("JudgeError", (error) =>
      Option.match(Option.fromUndefinedOr(error.target), {
        onNone: () => Effect.succeed(unchanged(input)),
        onSome: () => Effect.fail(error),
      }),
    ),
  );
