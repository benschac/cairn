import {
  Config as ConfigSchema,
  Judgments,
  Manifest,
  PrdSectionId,
  Slug,
  SpecSectionId,
} from "@cairn/contract";
import type {
  Config as CairnConfig,
  Judgment,
  JudgmentQuestion,
  ManifestTask,
  Section,
  SpecIndex,
} from "@cairn/contract";
import {
  assignItemIds,
  assignSectionIds,
  bodyHashOf,
  changeQuestions,
  cosmeticOf,
  itemQuestions,
  derivedOf,
  gateOf,
  inputsOf,
  itemsOf,
  lint,
  outOfDateOf,
  partOf,
  prdSectionsBuiltBy,
  refusalOf,
  replanOf,
  scopeOf,
  sectionIdsOf,
  sectionsOf,
  stackOf,
  uncoveredItemsOf,
  uncoveredOf,
  withImplements,
  withStackDiagram,
  yesNoOf,
} from "@cairn/core";
import type { Finding, Item, JudgingInputs, Part, Replan, UnmappedItem } from "@cairn/core";
import {
  Array,
  Console,
  Duration,
  Effect,
  FileSystem,
  HashMap,
  HashSet,
  Layer,
  Number,
  Option,
  Order,
  Path,
  PlatformError,
  Predicate,
  Record,
  Ref,
  Result,
  Runtime,
  Schema,
  String,
  Struct,
  Terminal,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  askStatements,
  draftCountOf,
  draftStatements,
  draftWarning,
  partsToDraft,
  targetsOf,
} from "../ask-statements.ts";
import { replaceFile } from "../atomic-write.ts";
import { layer as gitLayer } from "../git-live.ts";
import { Git } from "../git.ts";
import { Judge, JudgeError, inputHashesOf } from "../judge.ts";
import { MainCheckout } from "../main-checkout.ts";
import { livePlannerModels } from "../models.ts";
import { Planner, PlannerError } from "../planner.ts";
import { changeLines, flagsOf, reportLines, targetName } from "../print-judgments.ts";
import { stackLines, totalsLine } from "../print-stack.ts";
import { refineWith } from "../refine.ts";
import type { RefineInput, Refined } from "../refine.ts";
import { editedOf, specIndexOf, specIndexText } from "../spec-index.ts";
import { mergeSections } from "../spec-merge.ts";
import {
  CAIRN_DIRECTORY,
  loadConfig,
  loadJudgments,
  loadManifest,
  loadPrd,
  loadSpec,
  loadSpecIndex,
} from "../workspace.ts";
import { formatFinding } from "./lint.ts";

/** `--respec` was passed, and a task has left `pending`: planning from nothing would discard its work. */
export class RespecRefused extends Schema.TaggedError<
  RespecRefused,
  { readonly brand: unique symbol }
>()("RespecRefused", { tasks: Schema.Array(Schema.String) }) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `cairn plan --respec is refused: ${Array.join(this.tasks, ", ")} left pending. Re-planning a started stack is not supported.`;
  }
}

/** The tasks drafted have lint errors, so `manifest.json` was not written. */
export class ManifestRefused extends Schema.TaggedError<
  ManifestRefused,
  { readonly brand: unique symbol }
>()("ManifestRefused", { errors: Schema.Int }) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `manifest.json was not written: lint found ${this.errors} ${this.errors === 1 ? "error" : "errors"}`;
  }
}

/** `--source`, `--provider` or `--model` gave a planner config that does not decode. */
export class PlannerRefused extends Schema.TaggedError<
  PlannerRefused,
  { readonly brand: unique symbol }
>()("PlannerRefused", { reason: Schema.String }) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `cairn plan: ${this.reason}`;
  }
}

/** `cairn plan <id>` named IDs it cannot plan, or `--respec` came with IDs: nothing was written. */
export class PartRefused extends Schema.TaggedError<
  PartRefused,
  { readonly brand: unique symbol }
>()("PartRefused", { lines: Schema.Array(Schema.String) }) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return Array.join(this.lines, "\n");
  }
}

export const JUDGING_SKIPPED =
  "Judging skipped: set TYPESAFE_API_KEY, or judge.gatewayTokenEnv for Cloudflare AI Gateway.";
export const UP_TO_DATE = "The plan is up to date.";
export const PART_UP_TO_DATE = "This part is up to date.";
export const NOT_PLANNED_YET = "Not planned yet:";
export const RESPEC_TAKES_NO_IDS = "--respec plans the whole spec from nothing and takes no IDs.";
export const DRAFT_QUESTION = "Draft tasks from this spec? [y/N]";
export const WRITE_QUESTION = "Write manifest.json? [y/N]";
export const EDIT_SPEC = "Edit .cairn/spec.md, then run cairn plan again.";

/** The branch tasks start from, until the PRD can name another. */
const BASE_BRANCH = "main";

/** The feature a plan has when its PRD's first heading gives no usable name. */
const FALLBACK_FEATURE = Schema.decodeSync(Slug)("plan");

const ManifestJson = Schema.fromJsonString(Manifest, { space: 2 });
const JudgmentsText = Schema.fromJsonString(Judgments, { space: 2 });

/** The planner fields `--source`, `--provider` and `--model` replace for one run. */
export interface PlannerChoice {
  readonly model: string | undefined;
  readonly provider: CairnConfig["planner"]["provider"] | undefined;
  readonly source: CairnConfig["planner"]["source"] | undefined;
}

/** What `cairn plan` was asked: `--spec`, `--yes`, `--respec`, `--accept`, `--dry-run` and the planner flags. */
export interface PlanOptions {
  /** A spec section whose PRD sections are accepted as they are now (`spec.planning.again`). It plans nothing. */
  readonly accept?: string | undefined;
  /** Run both steps in memory: ask nothing, write nothing, and print totals (`spec.planning.dry-run`). */
  readonly dryRun?: boolean;
  /** The PRD heading and list item IDs to plan, and what is under them (`spec.planning.planning-a-part`). None plans the whole PRD. */
  readonly part?: ReadonlyArray<string> | undefined;
  /** Planner fields that replace the config's for this run. */
  readonly planner?: PlannerChoice;
  readonly respec: boolean;
  readonly spec: boolean;
  readonly yes: boolean;
}

/** The planner of the config, as it is. */
const KEEP_PLANNER: PlannerChoice = { model: undefined, provider: undefined, source: undefined };

/**
 * `config.json` with the planner fields of `choice` laid over it, decoded again so a choice the
 * config would refuse (`--source api` with no model) is refused here, before any call.
 */
export const configOf = Effect.fn("plan.configOf")(function* (
  choice: PlannerChoice = KEEP_PLANNER,
) {
  const config = yield* loadConfig;
  const chosen = Record.filter(choice, Predicate.isNotUndefined);
  if (Record.isEmptyRecord(chosen)) {
    return config;
  }
  return yield* Schema.decodeEffect(ConfigSchema)({
    ...config,
    planner: { ...config.planner, ...chosen },
  }).pipe(Effect.mapError((error) => new PlannerRefused({ reason: error.message })));
});

/**
 * The file system of a dry run: reads see what the run has written, and a write is kept in memory
 * and never reaches the disk, so the steps read each other's files as they do in a real run.
 *
 * A run writes each file by staging it and renaming it into place (`replaceFile`), so the staging
 * calls are kept in memory too: a staging directory is only a name, `chmod` on a staged file does
 * nothing, and `rename` and `link` move what the run wrote. Asked to move or chmod a file the run
 * did not write, it dies rather than touch the disk.
 */
const inMemory = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const disk = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const written = yield* Ref.make(HashMap.empty<string, string>());
    const staged = yield* Ref.make(0);
    const kept = (path: string) => Effect.map(Ref.get(written), HashMap.get(path));
    /** What the run wrote at `path`; anything else is on disk, which a dry run leaves alone. */
    const own = (method: string, path: string) =>
      kept(path).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die(`A dry run cannot ${method} ${path}: it did not write it`),
            onSome: Effect.succeed,
          }),
        ),
      );
    const moved = (from: string, to: string, data: string) =>
      Ref.update(written, (files) => HashMap.set(HashMap.remove(files, from), to, data));
    const exists = (path: string) =>
      kept(path).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => disk.exists(path), onSome: () => Effect.succeed(true) }),
        ),
      );
    return {
      ...disk,
      chmod: (path) => Effect.asVoid(own("chmod", path)),
      link: (from, to) =>
        own("link", from).pipe(
          Effect.flatMap((data) =>
            exists(to).pipe(
              Effect.filterOrFail(
                (taken) => !taken,
                () =>
                  PlatformError.systemError({
                    _tag: "AlreadyExists",
                    method: "link",
                    module: "FileSystem",
                    pathOrDescriptor: to,
                  }),
              ),
              Effect.andThen(Ref.update(written, HashMap.set(to, data))),
            ),
          ),
        ),
      makeTempDirectoryScoped: ({ directory = paths.sep, prefix = "" } = {}) =>
        Ref.updateAndGet(staged, (count) => count + 1).pipe(
          Effect.map((count) => paths.join(directory, `${prefix}dry-run-${count}`)),
        ),
      rename: (from, to) =>
        own("rename", from).pipe(Effect.flatMap((data) => moved(from, to, data))),
      exists,
      readFileString: (path, encoding) =>
        kept(path).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => disk.readFileString(path, encoding),
              onSome: Effect.succeed,
            }),
          ),
        ),
      writeFileString: (path, data) => Ref.update(written, HashMap.set(path, data)),
    };
  }),
);

/** What a run planned, for the totals line of a dry run. */
interface Planned {
  readonly errors: number;
  readonly flags: number;
  /** The IDs a part run named, in document order; none for a run of the whole PRD. */
  readonly part: ReadonlyArray<string>;
  readonly sections: number;
  readonly tasks: number;
}

const nothingPlanned: Planned = { errors: 0, flags: 0, part: [], sections: 0, tasks: 0 };

/**
 * The feature's name for the manifest: the ID of the first heading of the PRD, without `prd.`,
 * which is already kebab-case.
 */
const featureOf = (prd: string): Slug =>
  Array.findFirst(sectionsOf(prd), (section) => Predicate.isNotUndefined(section.id)).pipe(
    Option.flatMapNullishOr((section) => section.id),
    Option.map(String.replace(/^prd\./u, "")),
    Option.map(String.replaceAll(".", "-")),
    Option.flatMap(Schema.decodeUnknownOption(Slug)),
    Option.getOrElse(() => FALLBACK_FEATURE),
  );

/** A yes or no from the person: `y` or `yes`. Anything else, and the end of input, is no. `--yes` answers yes without asking. */
const confirm = Effect.fn("plan.confirm")(function* (question: string, yes: boolean) {
  if (yes) {
    return true;
  }
  const terminal = yield* Terminal.Terminal;
  yield* terminal.display(`${question} `);
  const answer = yield* terminal.readLine.pipe(
    Effect.catchTag("QuitError", () => Effect.succeed("")),
  );
  return Array.contains(["y", "yes"], String.toLowerCase(String.trim(answer)));
});

/**
 * The judge of the judging checkpoints (`spec.judging.checkpoints`), when the run was given one.
 * It is asked for, not required (`spec.refactors.optional-services`): `cairn plan` provides a
 * `Judge` only when `TYPESAFE_API_KEY` or `judge.gatewayTokenEnv` is set
 * (`Judge.whenConfigured`). Without one, the first call prints once that judging was skipped.
 */
const judging = Effect.fn("plan.judging")(function* (told: Ref.Ref<boolean>) {
  const judge = yield* Effect.serviceOption(Judge);
  const already = yield* Ref.getAndSet(told, true);
  if (Option.isNone(judge) && !already) {
    yield* Console.log(JUDGING_SKIPPED);
  }
  return judge;
});

/** A judge that failed does not stop the plan: it says so, and the planner's work stands as it was. */
const failedAs =
  <A>(unjudged: A) =>
  (error: JudgeError) =>
    Console.log(`Judging failed: ${error.message}`).pipe(Effect.as(unjudged));

const optionally = <A, E, R>(load: Effect.Effect<A, E | { readonly _tag: "MissingFile" }, R>) =>
  load.pipe(
    Effect.asSome,
    Effect.catchTag("MissingFile", () => Effect.succeedNone),
  );

/** Text that ends in one newline, as the files of `.cairn/` do. */
const withNewline = (text: string) => (String.endsWith("\n")(text) ? text : `${text}\n`);

/** What a step reads: the options, the PRD with its IDs, and the config. */
interface Inputs {
  readonly config: CairnConfig;
  /** What judging has said in this run, in the order it said it. `judgments.json` keeps them. */
  readonly judged: Ref.Ref<ReadonlyArray<Judgment>>;
  readonly options: PlanOptions;
  /** The part of the PRD this run plans, when it was given IDs. */
  readonly part: Option.Option<Part>;
  readonly prd: string;
  readonly told: Ref.Ref<boolean>;
}

/** `--accept` named a section it cannot accept. */
export class AcceptRefused extends Schema.TaggedError<
  AcceptRefused,
  { readonly brand: unique symbol }
>()("AcceptRefused", { reason: Schema.String, section: Schema.String }) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `cairn plan --accept ${this.section} is refused: ${this.reason}`;
  }
}

/** `prd.md` with the IDs a part run gives it: the headings', then the list items' that ask for one. */
const withIds = (prd: string) => {
  const headings = assignSectionIds(prd, "prd");
  const items = assignItemIds(headings.markdown);
  return { added: Array.appendAll(headings.added, items.added), markdown: items.markdown };
};

/**
 * `prd.md` as the run reads it, with the IDs it gives, and the part the run was asked to plan. A
 * part run assigns item IDs as well, so an item whose `{#}` is filled in this run can be named. An
 * ID that names nothing, and `--respec` with IDs, are refused here, before anything is written.
 */
const identified = Effect.fn("plan.identified")(function* (options: PlanOptions, prdText: string) {
  const given = Option.getOrElse(
    Option.fromUndefinedOr(options.part),
    (): ReadonlyArray<string> => [],
  );
  if (!Array.isReadonlyArrayNonEmpty(given)) {
    const { added, markdown } = assignSectionIds(prdText, "prd");
    return { added, markdown, part: Option.none<Part>() };
  }
  yield* Effect.filterOrFail(
    Effect.succeed(options.respec),
    (respec) => !respec,
    () => new PartRefused({ lines: [RESPEC_TAKES_NO_IDS] }),
  );
  const { added, markdown } = withIds(prdText);
  const sections = sectionsOf(markdown);
  const part = yield* Effect.fromResult(partOf(sections, itemsOf(markdown, sections), given)).pipe(
    Effect.mapError(({ unknown }) => new PartRefused({ lines: Array.map(unknown, refusalOf) })),
  );
  return { added, markdown, part: Option.some(part) };
});

/** The IDs of a part as plain strings, which is how statements' owners and findings name them. */
const idsOfPart = (part: Part) => HashSet.fromIterable<string>(part.ids);

/** The line both reviews of a part run open with: what was named and how much sits under it. */
const partLines = (part: Option.Option<Part>): ReadonlyArray<string> =>
  Option.match(part, {
    onNone: () => [],
    onSome: ({ ids, named }) => {
      const below = HashSet.size(ids) - Array.length(named);
      const noun = below === 1 ? "section" : "sections";
      const pronoun = Array.length(named) === 1 ? "it" : "them";
      return [
        `part: ${Array.join(named, ", ")}${below === 0 ? "" : ` (and ${below} ${noun} under ${pronoun})`}`,
      ];
    },
  });

/** The spec a part run starts when there is none: one heading, so the run writes no more of the spec than the part. */
const specStartOf = (prd: string): string =>
  withNewline(
    assignSectionIds(
      `# ${Option.match(
        Array.findFirst(sectionsOf(prd), (section) => section.level === 1),
        { onNone: () => "Plan", onSome: ({ title }) => title },
      )} spec`,
      "spec",
    ).markdown,
  );

/** `spec.json` of a spec that has no sections yet, which a part run narrows against when there is no spec. */
const NO_INDEX: SpecIndex = {
  manifest: `${CAIRN_DIRECTORY}/manifest.json`,
  prd: `${CAIRN_DIRECTORY}/prd.md`,
  sections: [],
  source: `${CAIRN_DIRECTORY}/spec.md`,
  tasks: [],
  version: 1,
};

const isPrdSectionId = Schema.is(PrdSectionId);

/**
 * The PRD sections and list items that no spec section covers, as `cairn lint` counts them: a
 * section whose items are named is covered, and an item is covered when a key names it.
 * `replanOf`'s `uncovered` holds headings only, and its `unmappedItems` are planned only when no
 * candidate builds them (`spec.planning.again.mapping-items`), so a part run reads the items here,
 * or a part named by an item would plan nothing and lint would still refuse it.
 */
const uncoveredWithItems = (prd: string, spec: string): ReadonlyArray<PrdSectionId> => {
  const prdSections = sectionsOf(prd);
  const items = itemsOf(prd, prdSections);
  const specSections = sectionsOf(spec);
  return Array.filter(
    Array.map(
      Array.appendAll(
        uncoveredOf(prdSections, specSections, items),
        uncoveredItemsOf(prdSections, specSections, items),
      ),
      ({ id }) => id,
    ),
    isPrdSectionId,
  );
};

/** `whole`, the plan's `replanOf`, narrowed to the part when the run has one. */
const narrowed = (
  part: Option.Option<Part>,
  whole: Replan,
  prd: string,
  spec: string,
  index: SpecIndex,
): Replan =>
  Option.match(part, {
    onNone: () => whole,
    onSome: (found) =>
      scopeOf({ ...whole, uncovered: uncoveredWithItems(prd, spec) }, found, index),
  });

/** What the run acts on: the whole plan's `replanOf`, narrowed to the part when the run has one. */
const replanFor = (
  part: Option.Option<Part>,
  prd: string,
  spec: string,
  index: SpecIndex,
  manifest: Option.Option<Manifest>,
): Replan => narrowed(part, replanOf(prd, spec, index, manifest), prd, spec, index);

/**
 * Says which sections a part run left alone that the whole plan would have written again: they
 * implement the part and something outside it, and a PRD section they implement changed. Lint does
 * not report a section Cairn could rewrite, so the run does.
 */
const reportMoved = Effect.fn("plan.reportMoved")(function* (
  spec: string,
  whole: Replan,
  scoped: Replan,
) {
  const moved = HashSet.fromIterable<string>(
    Array.filter(scoped.staleSections, (id) => !Array.contains(whole.staleSections, id)),
  );
  const found = Array.filter(
    sectionsOf(spec),
    ({ id }) => Predicate.isNotUndefined(id) && HashSet.has(moved, id),
  );
  yield* Effect.forEach(
    found,
    ({ id, line }) =>
      Console.log(
        formatFinding({
          file: "spec.md",
          line: Option.some(line),
          message: `${id} implements the part and sections outside it, and a PRD section it implements changed, so this run left it as it was. Update it if it needs it, then run cairn plan --accept ${id}.`,
          rule: "stale-section",
          severity: "warning",
        }),
      ),
    { discard: true },
  );
});

/**
 * A finding that says a PRD section or item outside `part` is not planned, which a part run lets
 * through. Both unmapped rules begin their message with the ID.
 */
const notPlannedYet = (part: HashSet.HashSet<string>, finding: Finding) =>
  (finding.rule === "unmapped-section" || finding.rule === "unmapped-item") &&
  !HashSet.has(part, Array.headNonEmpty(String.split(finding.message, " ")));

/** Replaces one file in `.cairn/` atomically, so `cairn serve` and an interrupted plan never see it half written. */
const writeCairn = Effect.fn("plan.write")(function* (name: string, content: string) {
  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  yield* replaceFile(path.join(root, CAIRN_DIRECTORY, name), content);
});

/**
 * The sections and task checkpoints (`spec.judging.checkpoints`) over `input`, or `input` as it
 * is when there is no key or the judge fails. It records nothing: the caller names the draft
 * judgments by task once the stack has IDs, and then records them with `record`.
 */
const refined = Effect.fn("plan.refined")(function* ({ config, told }: Inputs, input: RefineInput) {
  const unjudged: Refined = { drafts: input.drafts, judgments: [], spec: input.spec };
  const maybeJudge = yield* judging(told);
  return yield* Option.match(maybeJudge, {
    onNone: () => Effect.succeed(unjudged),
    onSome: (judge) =>
      refineWith(input, config).pipe(
        Effect.provideService(Judge, judge),
        Effect.catchTag("JudgeError", failedAs(unjudged)),
      ),
  });
});

/** What the fourth checkpoint asks: `built` of PRD sections, `ordered` of tasks, `oneFeature` of the stack. */
const FOURTH_CHECKPOINT: ReadonlyArray<JudgmentQuestion> = ["built", "ordered", "oneFeature"];

/**
 * The fourth checkpoint (`spec.judging.checkpoints`), asked of the manifest the plan would write:
 * `built` for each PRD section the new tasks implement, `ordered` for each new task and
 * `oneFeature` for the stack. It only reports. A part run's stack lists only the part's PRD
 * sections, the feature this run builds.
 */
const stackJudged = Effect.fn("plan.stackJudged")(function* (
  { config, part, told }: Inputs,
  prd: string,
  spec: string,
  manifest: Manifest,
  added: ReadonlyArray<ManifestTask>,
) {
  const none: ReadonlyArray<Judgment> = [];
  const maybeJudge = yield* judging(told);
  return yield* Option.match(maybeJudge, {
    onNone: () => Effect.succeed(none),
    onSome: (judge) => {
      const all = inputsOf(prd, spec, manifest);
      const whole = all.stack;
      const fresh = HashSet.fromIterable(Array.map(added, Struct.get("id")));
      const built = HashSet.fromIterable<string>(prdSectionsBuiltBy(prd, spec, added));
      // A part run asks whether the stack builds the part's PRD sections, not the ones left for later.
      const stack = Option.match(part, {
        onNone: () => whole,
        onSome: (found) => {
          const ids = idsOfPart(found);
          return {
            ...whole,
            prdSections: Array.filter(whole.prdSections, ({ id }) => HashSet.has(ids, id)),
          };
        },
      });
      return judge
        .judge(
          {
            prdSections: Array.filter(all.prdSections, ({ id }) => HashSet.has(built, id)),
            sections: [],
            stack,
            tasks: Array.filter(all.tasks, ({ id }) => HashSet.has(fresh, id)),
          },
          { judgments: [], model: config.judge.model, version: 1 },
          { asks: (question) => Array.contains(FOURTH_CHECKPOINT, question) },
        )
        .pipe(
          Effect.map(({ judgments }) => judgments),
          Effect.catchTag("JudgeError", failedAs(none)),
        );
    },
  });
});

/**
 * `judgments` with each new task's earlier judgments given the hash `cairn judge` computes for the
 * task. `refine` asked them of drafts before `stackOf`, when a task had no `others`; those
 * questions do not read `others`, so a judgment whose hash is the task's input with `others` left
 * empty holds for the input with them, and `cairn judge` then keeps it instead of asking again. A
 * judgment asked of a different input, such as a dependency named by ID, keeps its hash.
 */
const restamped = Effect.fn("plan.restamped")(function* (
  { config }: Inputs,
  prd: string,
  spec: string,
  manifest: Manifest,
  added: ReadonlyArray<ManifestTask>,
  judgments: ReadonlyArray<Judgment>,
) {
  const fresh = HashSet.fromIterable(Array.map(added, Struct.get("id")));
  const all = inputsOf(prd, spec, manifest);
  const tasks = Array.filter(all.tasks, ({ id }) => HashSet.has(fresh, id));
  const byTask = (inputs: JudgingInputs) =>
    Effect.map(inputHashesOf(inputs, config), (hashes) =>
      HashMap.fromIterable(
        Array.filterMap(hashes, ({ hash, target }) =>
          target.kind === "task" ? Result.succeed([target.id, hash] as const) : Result.failVoid,
        ),
      ),
    );
  const only = { prdSections: [], sections: [], stack: all.stack };
  const final = yield* byTask(Struct.assign(only, { tasks }));
  const asked = yield* byTask(
    Struct.assign(only, {
      tasks: Array.map(tasks, (entry) =>
        Struct.evolve(entry, { input: (input) => Struct.evolve(input, { others: () => [] }) }),
      ),
    }),
  );
  return Array.map(judgments, (judgment) =>
    judgment.target.kind === "task" && judgment.question !== "ordered"
      ? Option.match(
          Option.all([
            HashMap.get(asked, judgment.target.id),
            HashMap.get(final, judgment.target.id),
          ]),
          {
            onNone: () => judgment,
            onSome: ([before, after]) =>
              judgment.inputHash === before
                ? Struct.evolve(judgment, { inputHash: () => after })
                : judgment,
          },
        )
      : judgment,
  );
});

/** Adds `judgments` to what this run has judged. */
const record = ({ judged }: Inputs, judgments: ReadonlyArray<Judgment>) =>
  Ref.update(judged, Array.appendAll(judgments));

/**
 * Writes `judgments.json`: what this run judged, and what the file already holds about anything
 * else, when the same model gave it. A judgment of this run replaces the file's for the same target
 * and question. A run that judged nothing leaves the file alone.
 */
const writeJudgments = Effect.fn("plan.writeJudgments")(function* ({ config, judged }: Inputs) {
  const current = yield* Ref.get(judged);
  if (Array.isReadonlyArrayEmpty(current)) {
    return;
  }
  const previous = yield* loadJudgments;
  const asked = HashSet.fromIterable(
    Array.map(current, ({ question, target }) => `${targetName(target)} ${question}`),
  );
  const kept = Option.match(previous, {
    onNone: () => [],
    onSome: ({ judgments, model }) =>
      model === config.judge.model
        ? Array.filter(
            judgments,
            ({ question, target }) => !HashSet.has(asked, `${targetName(target)} ${question}`),
          )
        : [],
  });
  const text = yield* Schema.encodeEffect(JudgmentsText)({
    judgments: Array.appendAll(kept, current),
    model: config.judge.model,
    version: 1,
  });
  yield* writeCairn("judgments.json", withNewline(text));
});

/** Each section of the spec as it was written: its ID, its line and the PRD sections it implements. */
const sectionLine = (section: Section) =>
  Array.join(
    Array.appendAll(
      [`${section.id}`, `${CAIRN_DIRECTORY}/spec.md:${section.line}`],
      Array.match(section.keys.implements, {
        onEmpty: () => [],
        onNonEmpty: (implemented) => [`implements ${Array.join(implemented, ", ")}`],
      }),
    ),
    "  ",
  );

/** The tasks of a manifest, none when there is no manifest. */
const tasksOf = (manifest: Option.Option<Manifest>): ReadonlyArray<ManifestTask> =>
  Option.match(manifest, { onNone: () => [], onSome: (existing) => existing.tasks });

const isSpecSectionId = Schema.is(SpecSectionId);

/** The IDs of the spec sections in `spec`. */
const specIdsOf = (spec: string) => Array.filter(sectionIdsOf(spec), isSpecSectionId);

/** What `writeIndex` is told about `spec.json` as it is and what changes in it. */
interface IndexChange {
  /** Sections `Planner.index` reads again, because their body changed. */
  readonly changed: ReadonlyArray<SpecSectionId>;
  /** `spec.json` as it is on disk. A section it has keeps its entry. */
  readonly previous: Option.Option<SpecIndex>;
  /** Sections Cairn writes or rewrites in this run. */
  readonly written: ReadonlyArray<SpecSectionId>;
  /** Sections Cairn edited in place, whose `writtenFrom.body` is recorded again. */
  readonly rehashed?: ReadonlyArray<SpecSectionId> | undefined;
}

/** Writes `spec.json` for the `spec.md` on disk (`spec.contract.spec-index`). */
const writeIndex = Effect.fn("plan.writeIndex")(function* (
  prd: string,
  manifest: Option.Option<Manifest>,
  { changed, previous, rehashed, written }: IndexChange,
) {
  const spec = yield* loadSpec;
  const index = yield* specIndexOf({
    changed,
    rehashed,
    manifest: { tasks: tasksOf(manifest) },
    prd,
    previous,
    spec,
    written,
  });
  const text = yield* specIndexText(index);
  yield* writeCairn("spec.json", text);
});

/** `spec.json` as it is on disk, or the one `writeIndex` makes when there is none. */
const currentIndex = Effect.fn("plan.currentIndex")(function* (
  prd: string,
  manifest: Option.Option<Manifest>,
) {
  const previous = yield* loadSpecIndex;
  if (Option.isSome(previous)) {
    return previous.value;
  }
  yield* writeIndex(prd, manifest, { changed: [], previous, written: [] });
  return yield* Effect.flatMap(loadSpecIndex, (made) => Effect.fromOption(made).pipe(Effect.orDie));
});

/**
 * `currentIndex` for a part run, with an entry for every section of `spec.md`. A section a person
 * added has none, and `scopeOf` reads what a section implements from its entry, so no part would
 * own it and its task would never be drafted.
 */
const partIndex = Effect.fn("plan.partIndex")(function* (
  prd: string,
  manifest: Option.Option<Manifest>,
) {
  const index = yield* currentIndex(prd, manifest);
  const spec = yield* loadSpec;
  const known = HashSet.fromIterable<string>(Array.map(index.sections, ({ id }) => id));
  if (Array.every(specIdsOf(spec), (id) => HashSet.has(known, id))) {
    return index;
  }
  yield* writeIndex(prd, manifest, { changed: [], previous: Option.some(index), written: [] });
  return yield* Effect.flatMap(loadSpecIndex, (made) => Effect.fromOption(made).pipe(Effect.orDie));
});

/** The index a run reads: made complete for a part run, as it is on disk for any other. */
const indexFor = (part: Option.Option<Part>, prd: string, manifest: Option.Option<Manifest>) =>
  Option.isSome(part) ? partIndex(prd, manifest) : currentIndex(prd, manifest);

/** The sections that `stale-section` and `stale-task` report, printed as `cairn lint` prints them. */
const reportStale = Effect.fn("plan.reportStale")(function* (
  { config, prd }: Inputs,
  spec: string,
  manifest: Option.Option<Manifest>,
  index: SpecIndex,
) {
  const stale = Array.filter(
    lint(prd, spec, manifest, config, Option.some(index)),
    (finding) => finding.rule === "stale-section" || finding.rule === "stale-task",
  );
  yield* Effect.forEach(stale, (finding) => Console.log(formatFinding(finding)), {
    discard: true,
  });
});

/** How many revisions of `prd.md` are searched for the body a spec section was written from. */
const PRD_REVISIONS = 50;

const PRD_PATH = `${CAIRN_DIRECTORY}/prd.md`;

/** `section` is the one `id` names. */
const isSection = (section: Pick<Section, "id">, id: string) => section.id === id;

/** A changed PRD section to ask about: its ID and the hash of the body its spec section was written from. */
interface Recorded {
  readonly id: PrdSectionId;
  readonly hash: string;
}

/**
 * The body each of `wanted` had when its spec section was written: the PRD section's body at the
 * newest of the last `PRD_REVISIONS` commits of `prd.md` where it hashes to `hash`
 * (`spec.planning.again.cosmetic-edits`). None when no revision matches, when there is no `Git`,
 * and when git cannot read the history: each counts the change as material.
 */
const oldBodiesOf = Effect.fn("plan.oldBodiesOf")(function* (wanted: ReadonlyArray<Recorded>) {
  const none = Array.map(wanted, () => Option.none<string>());
  const git = yield* Effect.serviceOption(Git);
  if (Option.isNone(git) || Array.isReadonlyArrayEmpty(wanted)) {
    return none;
  }
  const reader = git.value;
  return yield* reader.revisionsOf(PRD_PATH, PRD_REVISIONS).pipe(
    Effect.flatMap((revisions) =>
      // Newest first, as `revisionsOf` lists them. A revision that cannot be read matches nothing.
      Effect.forEach(
        revisions,
        (revision) =>
          reader.fileAt(PRD_PATH, revision).pipe(
            Effect.map(sectionsOf),
            Effect.catchTag("GitError", () => Effect.succeed<ReadonlyArray<Section>>([])),
          ),
        { concurrency: 4 },
      ),
    ),
    Effect.map((revisions) =>
      Array.map(wanted, ({ hash, id }) =>
        Array.findFirst(revisions, (sections) =>
          Option.map(
            Array.findFirst(
              sections,
              (section) => isSection(section, id) && bodyHashOf(section.body) === hash,
            ),
            ({ body }) => body,
          ),
        ),
      ),
    ),
    Effect.catchTag("GitError", () => Effect.succeed(none)),
  );
});

/** A PRD section whose change the judge read as cosmetic, with the probability it gave `materialChange`. */
interface Cosmetic {
  readonly id: PrdSectionId;
  readonly probability: number;
}

/** The plan output's line for a section left unwritten because its PRD sections' changes look cosmetic. */
const cosmeticLine = (id: SpecSectionId, cosmetic: ReadonlyArray<Cosmetic>) =>
  `stale  ${id} (likely cosmetic: ${Array.join(
    Array.map(cosmetic, (found) => `${found.id}, ${Number.round(found.probability, 2)}`),
    "; ",
  )}), run cairn plan --accept ${id}`;

/**
 * `replan` with the sections whose PRD changes look cosmetic left unwritten
 * (`spec.planning.again.cosmetic-edits`). Before `Planner.sections` writes the `rewritable`
 * sections again, the judge is asked `changeQuestions` once for each changed PRD section they
 * implement, comparing its body now with the body its spec section was written from, and once more
 * for each other body another section records. A PRD section all of whose bodies' `materialChange`
 * reads `no` is cosmetic, and `cosmeticOf` moves each section whose changed
 * PRD sections are all cosmetic to `staleSections`; the run prints a line for each. With no
 * judge, a judge that fails, or no old body found, `replan` is as it was.
 */
const withoutCosmetic = Effect.fn("plan.withoutCosmetic")(function* (
  inputs: Inputs,
  spec: string,
  index: SpecIndex,
  replan: Replan,
) {
  if (Array.isReadonlyArrayEmpty(replan.rewritable)) {
    return replan;
  }
  const maybeJudge = yield* judging(inputs.told);
  if (Option.isNone(maybeJudge)) {
    return replan;
  }
  const judge = maybeJudge.value;
  const outOfDate = outOfDateOf(inputs.prd, spec, index);
  const rewriting = Array.filter(outOfDate, ({ id }) => Array.contains(replan.rewritable, id));
  // Each changed PRD section once for each body it was written from: two sections that implement
  // it can record different hashes.
  const wanted = Array.dedupeWith(
    Array.flatMap(rewriting, ({ changed, entry }) =>
      Array.filterMap(changed, (id) =>
        Option.match(Record.get(entry.writtenFrom.prd, id), {
          onNone: () => Result.failVoid,
          onSome: (hash): Result.Result<Recorded, void> => Result.succeed({ hash, id }),
        }),
      ),
    ),
    (a: Recorded, b: Recorded) => a.id === b.id && a.hash === b.hash,
  );
  const olds = yield* oldBodiesOf(wanted);
  const now = sectionsOf(inputs.prd);
  // A PRD section that was deleted, or whose old body was not found, is not asked about.
  const asked = Array.getSomes(
    Array.zipWith(wanted, olds, (recorded, old) =>
      Option.map(
        Option.all({
          before: old,
          current: Array.findFirst(now, (section) => isSection(section, recorded.id)),
        }),
        ({ before, current }) => ({
          input: { after: current.body, before, title: current.title },
          recorded,
        }),
      ),
    ),
  );
  if (Array.isReadonlyArrayEmpty(asked)) {
    return replan;
  }
  const outcomes = yield* judge
    .ask(
      changeQuestions,
      Array.map(asked, ({ input, recorded }) => ({ input, label: recorded.id })),
    )
    .pipe(Effect.catchTag("JudgeError", failedAs([])));
  const noes = Array.getSomes(
    Array.zipWith(asked, outcomes, ({ recorded }, { materialChange }) =>
      yesNoOf(materialChange, inputs.config.judge) === "no"
        ? Option.map(Result.getSuccess(materialChange), ({ probability }) => ({
            id: recorded.id,
            probability,
          }))
        : Option.none(),
    ),
  );
  // A PRD section is cosmetic when every body it was written from reads no; the line gives the
  // highest probability of a material change among them.
  const cosmetic = Array.filterMap(
    Array.dedupe(Array.map(wanted, ({ id }) => id)),
    (id): Result.Result<Cosmetic, void> => {
      const found = Array.filter(noes, (no) => no.id === id);
      return Array.length(found) === Array.length(Array.filter(wanted, (pair) => pair.id === id))
        ? Array.match(found, {
            onEmpty: () => Result.failVoid,
            onNonEmpty: (all) =>
              Result.succeed({
                id,
                probability: Array.max(
                  Array.map(all, ({ probability }) => probability),
                  Order.Number,
                ),
              }),
          })
        : Result.failVoid;
    },
  );
  const next = cosmeticOf(
    replan,
    HashSet.fromIterable(Array.map(cosmetic, ({ id }) => id)),
    outOfDate,
  );
  yield* Effect.forEach(
    Array.filter(rewriting, ({ id }) => !Array.contains(next.rewritable, id)),
    ({ changed, id }) =>
      Console.log(
        cosmeticLine(
          id,
          Array.filter(cosmetic, (found) => Array.contains(changed, found.id)),
        ),
      ),
    { discard: true },
  );
  return next;
});

/** A PRD item mapped to a spec section that builds it, with the probability the judge gave `buildsItem`. */
interface Mapping {
  readonly item: PrdSectionId;
  readonly probability: number;
  readonly section: SpecSectionId;
}

/** The plan output's line for an item added to a section's `Implements`. */
const mappedLine = ({ item, probability, section }: Mapping) =>
  `mapped ${item} → ${section} (${Number.round(probability, 2)})`;

/** The plan output's line for a human item that spec sections may build, which is never mapped. */
const humanItemLine = ({ candidates, item }: UnmappedItem) =>
  `not mapped ${item}: it is a human item, so name it in the Implements of ${Array.join(candidates, " or ")} by hand`;

/** Some spec section may already build the item. */
const hasCandidates = ({ candidates }: UnmappedItem) => Array.isReadonlyArrayNonEmpty(candidates);

/** What `mapItems` did: whether it wrote `spec.md` and `spec.json`, and the items to plan. */
interface ItemsMapped {
  /** Whether `spec.md` was written. */
  readonly mapped: boolean;
  /** Items no spec section builds: planned like an uncovered PRD section. */
  readonly planned: ReadonlyArray<PrdSectionId>;
}

/** A run that maps nothing: a first plan, `--respec`, or a part run with no spec yet. */
const NOTHING_MAPPED: ItemsMapped = { mapped: false, planned: [] };

/** How far a line is indented: the whitespace it starts with. */
const indentOf = (line: string) => String.length(line) - String.length(String.trimStart(line));

/** A line with nothing but whitespace on it. */
const isBlankLine = (text: string) => String.isEmpty(String.trim(text));

/** An item's `{#id}`, or a `{#}` asking for one, at the end of a line. */
const ITEM_ATTRIBUTE = /[ \t]*\{#[^}\s]*\}[ \t]*$/u;

/**
 * The source of the PRD item on 1-based line `line` of `prd`, as `itemQuestions` reads it: its
 * line and every line nested in it (items, `Done when:` statements, fenced examples), up to the
 * first line that is not blank and not indented deeper than the item. The item's indent is taken
 * off every line, and the `{#id}` attributes are left out.
 */
const itemSourceOf = (prd: string, line: number): string => {
  const lines = String.split(prd, "\n");
  const own = Option.getOrElse(Array.get(lines, line - 1), () => "");
  const depth = indentOf(own);
  const block = Array.prepend(
    Array.takeWhile(Array.drop(lines, line), (text) => isBlankLine(text) || indentOf(text) > depth),
    own,
  );
  return Array.join(
    Array.map(Array.reverse(Array.dropWhile(Array.reverse(block), isBlankLine)), (text) =>
      String.replace(ITEM_ATTRIBUTE, "")(isBlankLine(text) ? "" : String.slice(depth)(text)),
    ),
    "\n",
  );
};

/** What `mapItems` returns when it wrote nothing: only the items to plan. */
const unchanged = (planned: ReadonlyArray<PrdSectionId>): ItemsMapped => ({
  mapped: false,
  planned,
});

/** Whether the PRD item `id` is a human item (`Item.human`). */
const isHumanItem = (items: ReadonlyArray<Item>, id: PrdSectionId) =>
  Array.some(items, (item) => item.human && isSection(item, id));

/** A human item that spec sections may build: it is only reported, never asked about or planned. */
const reportedOnly = (items: ReadonlyArray<Item>, found: UnmappedItem) =>
  hasCandidates(found) && isHumanItem(items, found.item);

/**
 * Maps the PRD items given IDs after their section was planned (`spec.planning.again.mapping-items`).
 * For each of `unmapped` and each of its candidates the judge is asked `itemQuestions`:
 *
 * - `yes` for some candidates adds the item to each one's `Implements` (`withImplements`), writes
 *   `spec.md`, records each such section's body hash again in `spec.json` and prints a line.
 * - `no` for every candidate, or no candidate at all, plans the item: it is in `planned`.
 * - Anything else, no judge or a failed judge leaves the item as it is, and lint reports it.
 *
 * A human item with candidates is never asked about, since mapping it would gate the tasks of the
 * section; a line reports it.
 */
const mapItems = Effect.fn("plan.mapItems")(function* (
  inputs: Inputs,
  manifest: Option.Option<Manifest>,
  spec: string,
  index: SpecIndex,
  unmapped: ReadonlyArray<UnmappedItem>,
) {
  const prdSections = sectionsOf(inputs.prd);
  const items = itemsOf(inputs.prd, prdSections);
  const alone = Array.map(
    Array.filter(unmapped, (found) => !hasCandidates(found)),
    ({ item }) => item,
  );
  const human = Array.filter(unmapped, (found) => reportedOnly(items, found));
  yield* Effect.forEach(human, (found) => Console.log(humanItemLine(found)), { discard: true });
  const specSections = sectionsOf(spec);
  // One question for each candidate of each item that may be mapped.
  const asked = Array.flatMap(
    Array.filter(unmapped, (found) => hasCandidates(found) && !reportedOnly(items, found)),
    ({ candidates, item }: UnmappedItem) =>
      Array.getSomes(
        Array.map(candidates, (section: SpecSectionId) =>
          Option.map(
            Option.all({
              item: Array.findFirst(items, (found) => isSection(found, item)),
              target: Array.findFirst(specSections, (found) => isSection(found, section)),
            }),
            ({ item: text, target }) => ({
              input: {
                // The title of the heading the item is under; none when that heading has no ID.
                heading: Option.getOrElse(
                  Option.flatMap(Option.fromUndefinedOr(text.section), (under) =>
                    Option.map(
                      Array.findFirst(prdSections, (found) => isSection(found, under)),
                      ({ title }) => title,
                    ),
                  ),
                  () => "",
                ),
                item: itemSourceOf(inputs.prd, text.line),
                section: { body: target.body, files: target.keys.files, title: target.title },
              },
              item,
              section,
            }),
          ),
        ),
      ),
  );
  if (Array.isReadonlyArrayEmpty(asked)) {
    return unchanged(alone);
  }
  const maybeJudge = yield* judging(inputs.told);
  if (Option.isNone(maybeJudge)) {
    return unchanged(alone);
  }
  const outcomes = yield* maybeJudge.value
    .ask(
      itemQuestions,
      Array.map(asked, ({ input, item, section }) => ({ input, label: `${item} → ${section}` })),
    )
    .pipe(Effect.catchTag("JudgeError", failedAs([])));
  const answers = Array.zipWith(asked, outcomes, ({ item, section }, { buildsItem }) => ({
    answer: yesNoOf(buildsItem, inputs.config.judge),
    item,
    probability: Option.getOrElse(
      Option.map(Result.getSuccess(buildsItem), ({ probability }) => probability),
      () => 0,
    ),
    section,
  }));
  const mappings = Array.map(
    Array.filter(answers, ({ answer }) => answer === "yes"),
    ({ item, probability, section }): Mapping => ({ item, probability, section }),
  );
  // An item is planned when every candidate it was asked about reads no.
  const refused = Array.filterMap(unmapped, ({ candidates, item }) => {
    const mine = Array.filter(answers, (answer) => answer.item === item);
    return Array.isReadonlyArrayNonEmpty(candidates) &&
      Array.length(mine) === Array.length(candidates) &&
      Array.every(mine, ({ answer }) => answer === "no")
      ? Result.succeed(item)
      : Result.failVoid;
  });
  const planned = Array.appendAll(alone, refused);
  if (Array.isReadonlyArrayEmpty(mappings)) {
    return unchanged(planned);
  }
  const next = Array.reduce(mappings, spec, (text, { item, section }) =>
    withImplements(text, section, item),
  );
  yield* writeCairn("spec.md", next);
  yield* writeIndex(inputs.prd, manifest, {
    changed: [],
    previous: Option.some(index),
    rehashed: Array.dedupe(Array.map(mappings, ({ section }) => section)),
    written: [],
  });
  yield* Effect.forEach(mappings, (mapping) => Console.log(mappedLine(mapping)), { discard: true });
  return { mapped: true, planned };
});

/**
 * The mapping step of planning again (`spec.planning.again.mapping-items`), run before the
 * done-when statements so that an item it sends to planning has its statements drafted like any
 * uncovered PRD section. It reads the spec and index on disk; a run that plans the spec from
 * nothing, or a part run with no spec yet, maps nothing.
 */
const mapStep = Effect.fn("plan.mapStep")(function* (
  inputs: Inputs,
  manifest: Option.Option<Manifest>,
) {
  const { options, part, prd } = inputs;
  const existing = yield* optionally(loadSpec);
  if (options.respec || Option.isNone(existing)) {
    return NOTHING_MAPPED;
  }
  const spec = existing.value;
  const index = yield* indexFor(part, prd, manifest);
  return yield* mapItems(
    inputs,
    manifest,
    spec,
    index,
    replanFor(part, prd, spec, index, manifest).unmappedItems,
  );
});

/** Step 1: writes `spec.md` from the PRD and prints its sections. Returns whether it wrote and how many sections it printed. */
const specStep = Effect.fn("plan.specStep")(function* (
  inputs: Inputs,
  manifest: Option.Option<Manifest>,
  items: ItemsMapped,
) {
  const { options, part, prd } = inputs;
  const existing = yield* optionally(loadSpec);
  if (Option.isNone(part) && (options.respec || Option.isNone(existing))) {
    const planner = yield* Planner;
    const drafted = yield* planner.spec(prd);
    // Every section has an ID before judging, since a section without one is not judged.
    const generated = withNewline(assignSectionIds(drafted, "spec").markdown);
    const checked = yield* refined(inputs, {
      drafts: [],
      prd,
      spec: generated,
      specGenerated: true,
      written: specIdsOf(generated),
    });
    const spec = withNewline(checked.spec);
    yield* writeCairn("spec.md", spec);
    const shown = Array.filter(sectionsOf(spec), (section) => Predicate.isNotUndefined(section.id));
    yield* Effect.forEach(
      Array.appendAll(
        Array.map(shown, sectionLine),
        Array.appendAll(changeLines(checked.judgments), reportLines(checked.judgments)),
      ),
      (line) => Console.log(line),
      { discard: true },
    );
    yield* record(inputs, checked.judgments);
    // A respec replaces the manifest too, so the tasks of the one on disk are not the new spec's.
    yield* writeIndex(prd, options.respec ? Option.none() : manifest, {
      changed: [],
      previous: Option.none(),
      written: specIdsOf(spec),
    });
    yield* writeJudgments(inputs);
    return { sections: Array.length(shown), wrote: true };
  }
  // Planning again (`spec.planning.again`): the spec exists, so it is added to, never written from
  // nothing. A part run with no spec starts one with a heading, because writing the whole spec would
  // plan what was not named.
  const started = Option.isNone(existing);
  // `mapStep` has already mapped the items given IDs after their section was planned, so the spec
  // and index read here have the mappings made (`spec.planning.again.mapping-items`).
  const spec = Option.getOrElse(existing, () => specStartOf(prd));
  const index = started ? NO_INDEX : yield* indexFor(part, prd, manifest);
  yield* reportStale(inputs, spec, manifest, index);
  const whole = replanOf(prd, spec, index, manifest);
  const scoped = narrowed(part, whole, prd, spec, index);
  yield* reportMoved(spec, whole, scoped);
  const replan = yield* withoutCosmetic(
    inputs,
    spec,
    index,
    // A part run's `uncovered` already holds the part's items that are still unmapped, which it
    // plans as `spec.planning.planning-a-part` says; a mapped item has left it.
    Struct.evolve(scoped, {
      uncovered: (uncovered) => Array.dedupe(Array.appendAll(uncovered, items.planned)),
    }),
  );
  if (
    Array.isReadonlyArrayEmpty(replan.uncovered) &&
    Array.isReadonlyArrayEmpty(replan.rewritable)
  ) {
    return { sections: 0, wrote: items.mapped };
  }
  const rewriting = Array.filter(index.sections, (entry) =>
    Array.contains(replan.rewritable, entry.id),
  );
  const prdSections = Array.dedupe(
    Array.appendAll(
      replan.uncovered,
      Array.flatMap(rewriting, (entry) => entry.implements),
    ),
  );
  const planner = yield* Planner;
  const fragment = yield* planner.sections(
    prd,
    spec,
    prdSections,
    replan.rewritable,
    Option.getOrUndefined(Option.map(part, ({ ids }) => ids)),
  );
  const merged = mergeSections(spec, fragment, replan.rewritable);
  const before = HashSet.fromIterable<string>(sectionIdsOf(spec));
  /** The sections this run wrote or rewrote that `text` still has: judging may split one away. */
  const writtenIn = (text: string) => {
    const ids = specIdsOf(text);
    const present = HashSet.fromIterable<string>(ids);
    return Array.filter(
      Array.appendAll(
        Array.filter(ids, (id) => !HashSet.has(before, id)),
        merged.rewritten,
      ),
      (id) => HashSet.has(present, id),
    );
  };
  const assigned = withNewline(assignSectionIds(merged.markdown, "spec").markdown);
  const checked = yield* refined(inputs, {
    drafts: [],
    prd,
    spec: assigned,
    specGenerated: false,
    written: writtenIn(assigned),
  });
  const next = withNewline(checked.spec);
  yield* writeCairn("spec.md", next);
  const written = writtenIn(next);
  const added = HashSet.fromIterable<string>(written);
  const printed = Array.filter(
    sectionsOf(next),
    (section) => Predicate.isNotUndefined(section.id) && HashSet.has(added, section.id),
  );
  yield* Effect.forEach(
    Array.flatten([
      partLines(part),
      Array.map(printed, sectionLine),
      changeLines(checked.judgments),
      reportLines(checked.judgments),
    ]),
    (line) => Console.log(line),
    { discard: true },
  );
  yield* record(inputs, checked.judgments);
  // A spec the run started has no index, so every section of it is indexed.
  yield* writeIndex(prd, manifest, {
    changed: started ? [] : editedOf(next, index),
    previous: started ? Option.none() : Option.some(index),
    written: started ? specIdsOf(next) : written,
  });
  yield* writeJudgments(inputs);
  return { sections: Array.length(printed), wrote: true };
});

/**
 * Writes `drawn`, the spec with the stack diagram drawn from a manifest, when it differs from
 * `spec`, and says so. Returns whether it wrote.
 */
const drawDiagram = Effect.fn("plan.drawDiagram")(function* (spec: string, drawn: string) {
  if (drawn === spec) {
    return false;
  }
  yield* writeCairn("spec.md", drawn);
  yield* Console.log(`Drew the stack diagram in ${CAIRN_DIRECTORY}/spec.md`);
  return true;
});

/** Draws the stack diagram of a manifest on disk again when `spec.md` has drifted from it. Returns whether it wrote. */
const redraw = Effect.fn("plan.redraw")(function* (prd: string, manifest: Option.Option<Manifest>) {
  if (Option.isNone(manifest)) {
    return false;
  }
  const spec = yield* loadSpec;
  const wrote = yield* drawDiagram(spec, withStackDiagram(spec, manifest.value));
  if (wrote) {
    // Only the lines of the sections moved: a section the drawing added is the one that is indexed.
    yield* writeIndex(prd, manifest, {
      changed: [],
      previous: yield* loadSpecIndex,
      written: [],
    });
  }
  return wrote;
});

/**
 * The spec sections to draft tasks for: every section on a first plan, and otherwise the ones
 * `spec.planning.again` names, read from the spec and index on disk. None when there is nothing to draft.
 */
const draftable = Effect.fn("plan.draftable")(function* (
  inputs: Inputs,
  manifest: Option.Option<Manifest>,
) {
  const { options, part, prd } = inputs;
  const spec = yield* loadSpec;
  // A part run drafts only for the sections that implement the part, the ones it just wrote among them.
  if (Option.isNone(part) && (options.respec || Option.isNone(manifest))) {
    return Option.some<ReadonlyArray<SpecSectionId>>(specIdsOf(spec));
  }
  const index = yield* indexFor(part, prd, manifest);
  return Option.map(
    Option.liftPredicate(
      replanFor(part, prd, spec, index, manifest).untasked,
      Array.isReadonlyArrayNonEmpty,
    ),
    (ids): ReadonlyArray<SpecSectionId> => ids,
  );
});

/**
 * Step 2: drafts the tasks of `specSections` from the spec on disk, orders them after the tasks the
 * manifest has, lints them, and writes `manifest.json` when the person agrees. A dry run prints the
 * same and neither asks nor refuses nor writes. Returns what it planned.
 */
const tasksStep = Effect.fn("plan.tasksStep")(function* (
  inputs: Inputs,
  manifest: Option.Option<Manifest>,
  specSections: ReadonlyArray<SpecSectionId>,
) {
  const { config, judged, options, part, prd } = inputs;
  const planner = yield* Planner;
  const spec = yield* loadSpec;
  // `--respec` plans from nothing; otherwise the tasks in the manifest stay as they are.
  const kept = options.respec ? Option.none<Manifest>() : manifest;
  const existing = tasksOf(kept);
  const proposed = yield* planner.tasks(
    prd,
    spec,
    specSections,
    existing,
    Option.getOrUndefined(Option.map(part, ({ ids }) => ids)),
  );
  // The task size and routing checkpoints shape the drafts before the stack orders them. The spec
  // on disk has its IDs, which step 1 gave it, so each draft's sections are found.
  const checked = yield* refined(inputs, {
    drafts: proposed,
    prd,
    spec,
    specGenerated: false,
    written: [],
  });
  const drafts = checked.drafts;
  const prdSections = sectionsOf(prd);
  const specSectionsOf = sectionsOf(spec);
  const sections = Array.appendAll(prdSections, specSectionsOf);
  const items = itemsOf(prd, prdSections);
  const feature = Option.match(kept, {
    onNone: () => featureOf(prd),
    onSome: (plan) => plan.feature,
  });
  const ordered = yield* Effect.fromResult(
    stackOf(feature, drafts, (draft) => gateOf(draft, sections, config, [], items), existing),
  );
  yield* Effect.filterOrFail(
    Effect.succeed(Array.drop(ordered, Array.length(existing))),
    Array.isReadonlyArrayNonEmpty,
    () => new PlannerError({ call: "tasks", reason: "The planner drafted no tasks." }),
  );
  const added = Array.length(ordered) - Array.length(existing);
  const tasks = yield* Effect.filterOrFail(
    Effect.succeed(ordered),
    Array.isReadonlyArrayNonEmpty,
    () => new PlannerError({ call: "tasks", reason: "The planner drafted no tasks." }),
  );
  const drafted: Manifest = {
    baseBranch: Option.match(kept, {
      onNone: () => BASE_BRANCH,
      onSome: (plan) => plan.baseBranch,
    }),
    feature,
    tasks,
    version: 1,
  };
  // Every manifest write draws the stack diagram again, so lint reads the spec as it will be written.
  const drawn = withStackDiagram(spec, drafted);
  const found = lint(prd, drawn, Option.some(drafted), config);
  // What a part run leaves for later does not stop its write: it is listed apart from what does.
  const inPart = Option.map(part, idsOfPart);
  const isLater = (finding: Finding) => Option.exists(inPart, (ids) => notPlannedYet(ids, finding));
  const later = Array.filter(found, isLater);
  const findings = Array.filter(found, (finding) => !isLater(finding));
  // A judgment of a draft that became a task is named by the task's ID; one of a draft a split
  // replaced stays named by its title.
  const ids = HashMap.fromIterable(
    Array.map(
      Array.drop(ordered, Array.length(existing)),
      (task) => [task.title, task.id] as const,
    ),
  );
  const stack = yield* stackJudged(
    inputs,
    prd,
    drawn,
    drafted,
    Array.drop(ordered, Array.length(existing)),
  );
  const retargeted = Array.appendAll(
    Array.map(checked.judgments, (judgment) =>
      judgment.target.kind === "draft"
        ? Option.match(HashMap.get(ids, judgment.target.title), {
            onNone: () => judgment,
            onSome: (id) =>
              Struct.evolve(judgment, { target: () => ({ id, kind: "task" as const }) }),
          })
        : judgment,
    ),
    stack,
  );
  const judgments = yield* restamped(
    inputs,
    prd,
    drawn,
    drafted,
    Array.drop(ordered, Array.length(existing)),
    retargeted,
  ).pipe(Effect.catchTag("JudgeError", failedAs(retargeted)));
  yield* record(inputs, judgments);
  const old = HashSet.fromIterable(Array.map(existing, (task) => task.id));
  yield* Effect.forEach(
    Array.flatten([
      partLines(part),
      changeLines(judgments),
      stackLines(drafted.tasks, { isNew: (task) => !HashSet.has(old, task.id) }),
      Array.map(findings, formatFinding),
      Array.match(later, {
        onEmpty: () => [],
        onNonEmpty: (left) => Array.prepend(Array.map(left, formatFinding), NOT_PLANNED_YET),
      }),
      reportLines(judgments),
    ]),
    (line) => Console.log(line),
    { discard: true },
  );
  const errors = Array.length(Array.filter(findings, (finding) => finding.severity === "error"));
  const everything = yield* Ref.get(judged);
  const planned: Omit<Planned, "part"> = {
    errors,
    flags: flagsOf(everything),
    sections: 0,
    tasks: added,
  };
  if (options.dryRun === true) {
    return planned;
  }
  yield* Effect.filterOrFail(
    Effect.succeed(errors),
    (count) => count === 0,
    (count) => new ManifestRefused({ errors: count }),
  );
  const write = yield* confirm(WRITE_QUESTION, options.yes);
  if (write) {
    const encoded = yield* Schema.encodeEffect(ManifestJson)(drafted);
    yield* writeCairn("manifest.json", withNewline(encoded));
    yield* Console.log(`Wrote ${CAIRN_DIRECTORY}/manifest.json`);
    yield* drawDiagram(spec, drawn);
    const previous = yield* loadSpecIndex;
    yield* writeIndex(prd, Option.some(drafted), {
      changed: Option.match(previous, {
        onNone: () => [],
        onSome: (index) => editedOf(drawn, index),
      }),
      previous,
      written: [],
    });
    yield* writeJudgments(inputs);
  }
  return planned;
});

/** The IDs of the tasks that have left `pending`. */
const startedOf = (manifest: Option.Option<Manifest>) =>
  Array.filterMap(tasksOf(manifest), (task) =>
    task.status === "pending" ? Result.failVoid : Result.succeed(task.id),
  );

/** Refuses `--respec` when a task has left `pending`. */
const refuseRestart = (options: PlanOptions, manifest: Option.Option<Manifest>) =>
  options.respec
    ? Effect.filterOrFail(
        Effect.succeed(startedOf(manifest)),
        Array.isReadonlyArrayEmpty,
        (tasks) => new RespecRefused({ tasks }),
      )
    : Effect.void;

/**
 * Whether this run will call the planner, so the command builds the model only then: a plan that
 * is up to date, a run that stops at an existing spec and a refused `--respec` need none. A run
 * that may ask is counted as one that does. Refuses `--respec` as `plan` would.
 */
export const needsPlanner = Effect.fn("plan.needsPlanner")(function* (options: PlanOptions) {
  if (Predicate.isNotUndefined(options.accept)) {
    return false;
  }
  const manifest = yield* optionally(loadManifest);
  yield* refuseRestart(options, manifest);
  // The IDs of a part run are checked first, so a wrong one is refused before a model is built.
  if (
    Array.isReadonlyArrayNonEmpty(Option.getOrElse(Option.fromUndefinedOr(options.part), () => []))
  ) {
    yield* Effect.flatMap(loadPrd, (text) => identified(options, text));
  }
  const spec = yield* optionally(loadSpec);
  const generating = options.respec || Option.isNone(spec);
  const drafting = (options.respec || Option.isNone(manifest)) && !options.spec;
  if (generating || drafting) {
    return true;
  }
  // Planning again: the planner is needed to write sections, to draft tasks, or to index a section
  // `spec.json` does not have yet. The PRD is read with the IDs `plan` is about to give it.
  const index = yield* loadSpecIndex;
  const prdText = yield* loadPrd;
  const { markdown: prd, part } = yield* identified(options, prdText);
  return Option.match(Option.all({ index, spec }), {
    onNone: () => true,
    onSome: ({ index: written, spec: text }) => {
      const replan = replanFor(part, prd, text, written, manifest);
      const drawn = Option.match(manifest, {
        onNone: () => text,
        onSome: (plan) => withStackDiagram(text, plan),
      });
      const indexed = HashSet.fromIterable<string>(
        Array.map(written.sections, (entry) => entry.id),
      );
      const items = itemsOf(prd, sectionsOf(prd));
      return (
        Array.isReadonlyArrayNonEmpty(replan.uncovered) ||
        Array.isReadonlyArrayNonEmpty(replan.rewritable) ||
        // An item given an ID after its section was planned may be mapped, which indexes the
        // section again, or planned. A human item a section may build is only reported.
        Array.some(replan.unmappedItems, (found) => !reportedOnly(items, found)) ||
        Array.some(specIdsOf(drawn), (id) => !HashSet.has(indexed, id)) ||
        // An answer about a draft edits the PRD, which can make a section need writing again.
        (draftCountOf(prd, Option.map(part, idsOfPart)) > 0 &&
          !options.yes &&
          options.dryRun !== true) ||
        (!options.spec && Array.isReadonlyArrayNonEmpty(replan.untasked))
      );
    },
  });
});

/**
 * `--accept`: records the current hashes of the PRD sections a spec section implements in its
 * `writtenFrom` in `spec.json`, so the section is no longer out of date. Nothing else changes: not
 * the body hash, which stays what Cairn wrote or null for a person's section, and not another section.
 */
const accept = Effect.fn("plan.accept")(function* (section: string) {
  const refuse = (reason: string) => new AcceptRefused({ reason, section });
  const prdText = yield* loadPrd;
  const prd = assignSectionIds(prdText, "prd").markdown;
  const spec = yield* loadSpec;
  const manifest = yield* optionally(loadManifest);
  const previous = yield* Effect.flatMap(loadSpecIndex, (index) =>
    Effect.fromOption(index).pipe(Effect.mapError(() => refuse("spec.json does not exist"))),
  );
  const entry = yield* Array.findFirst(previous.sections, (found) => found.id === section).pipe(
    Effect.fromOption,
    Effect.mapError(() => refuse("spec.json has no such section")),
  );
  const current = yield* Array.findFirst(
    derivedOf({
      manifest: { tasks: tasksOf(manifest) },
      prd,
      previous: Option.some(previous),
      spec,
      written: [entry.id],
    }),
    (found) => found.id === entry.id,
  ).pipe(
    Effect.fromOption,
    Effect.mapError(() => refuse("spec.md has no such section")),
  );
  const accepted: SpecIndex = {
    ...previous,
    sections: Array.map(previous.sections, (found) =>
      found.id === entry.id
        ? { ...found, writtenFrom: { body: found.writtenFrom.body, prd: current.writtenFrom.prd } }
        : found,
    ),
  };
  const text = yield* specIndexText(accepted);
  yield* writeCairn("spec.json", text);
  yield* Console.log(`Accepted ${section}`);
});

/** Writes `prd.md`. */
const savePrd = (text: string) => writeCairn("prd.md", text);

/**
 * Settles the PRD's done-when statements before the spec is written (`spec.planning.done-when.asking-the-person`):
 * drafts them for the parts that have none, writes them into `prd.md`, then asks about each draft.
 * A first plan drafts for every section and item; planning again, only for the sections nothing
 * covers. Returns the PRD as it is after the answers.
 */
const statementsStep = Effect.fn("plan.statementsStep")(function* (
  config: CairnConfig,
  options: PlanOptions,
  prd: string,
  manifest: Option.Option<Manifest>,
  part: Option.Option<Part>,
  planned: ReadonlyArray<PrdSectionId>,
) {
  const spec = yield* optionally(loadSpec);
  // A first plan drafts for every section and item, and planning again for the sections nothing
  // covers. A part run does the same inside the part, and asks about the part's drafts only.
  const only: Option.Option<ReadonlyArray<string>> = yield* Option.match(spec, {
    onNone: () => Effect.succeed(Option.map(part, ({ ids }) => Array.fromIterable<string>(ids))),
    onSome: (text) =>
      options.respec
        ? Effect.succeedNone
        : Effect.map(indexFor(part, prd, manifest), (index) =>
            Option.some<ReadonlyArray<string>>(
              // The items mapping sends to planning are targets like the uncovered sections.
              Array.dedupe(
                Array.appendAll(replanFor(part, prd, text, index, manifest).uncovered, planned),
              ),
            ),
          ),
  });
  const targets = yield* partsToDraft(prd, targetsOf(prd, only), config.judge);
  const drafted = yield* draftStatements(prd, targets, savePrd);
  return yield* askStatements(drafted, options, savePrd, Option.map(part, idsOfPart));
});

/** The spec and the tasks: what `steps` does once the PRD's statements are settled. */
const planSteps = Effect.fn("plan.planSteps")(function* (
  inputs: Inputs,
  manifest: Option.Option<Manifest>,
  items: ItemsMapped,
) {
  const { options } = inputs;
  const { sections, wrote: specWritten } = yield* specStep(inputs, manifest, items);
  const toDraft = options.spec ? Option.none() : yield* draftable(inputs, manifest);
  if (Option.isNone(toDraft)) {
    // A manifest on disk keeps its diagram true, so a spec that drifted from it is drawn again.
    if (!specWritten && !(yield* redraw(inputs.prd, manifest))) {
      yield* Console.log(Option.isSome(inputs.part) ? PART_UP_TO_DATE : UP_TO_DATE);
    }
    const everything = yield* Ref.get(inputs.judged);
    return { ...nothingPlanned, flags: flagsOf(everything), sections };
  }
  const proceed = specWritten
    ? yield* confirm(DRAFT_QUESTION, options.yes || options.dryRun === true)
    : true;
  if (proceed) {
    const planned = yield* tasksStep(inputs, manifest, toDraft.value);
    return { ...planned, sections };
  }
  yield* Console.log(EDIT_SPEC);
  const everything = yield* Ref.get(inputs.judged);
  return { ...nothingPlanned, flags: flagsOf(everything), sections };
});

/**
 * Runs the steps of `cairn plan` (`spec.planning.cairn-plan`): the done-when statements, the spec,
 * then the tasks, each followed by a question. On a plan that has a spec or tasks already it plans again
 * (`spec.planning.again`): spec sections for PRD sections nothing covers, tasks for spec sections
 * nothing builds, and a report of what went stale; no task in the manifest changes. The judging
 * checkpoints (`spec.judging.checkpoints`) run inside the spec and tasks steps.
 */
const steps = Effect.fn("plan.steps")(function* (options: PlanOptions) {
  if (Predicate.isNotUndefined(options.accept)) {
    yield* accept(options.accept);
    return nothingPlanned;
  }
  const manifest = yield* optionally(loadManifest);
  yield* refuseRestart(options, manifest);

  const config = yield* configOf(options.planner);
  const told = yield* Ref.make(false);
  // The IDs of a part run are checked here, before anything is written, even the IDs the PRD lacks.
  const prdText = yield* loadPrd;
  const assigned = yield* identified(options, prdText);
  const { part } = assigned;
  if (Array.isReadonlyArrayNonEmpty(assigned.added)) {
    yield* writeCairn("prd.md", assigned.markdown);
    yield* Effect.forEach(assigned.added, (id) => Console.log(`Added ${id}`), { discard: true });
  }
  const judged = yield* Ref.make<ReadonlyArray<Judgment>>([]);
  // Mapping runs before the statements: an item it sends to planning has its statements drafted.
  const items = yield* mapStep(
    { config, judged, options, part, prd: assigned.markdown, told },
    manifest,
  );
  const prd = yield* statementsStep(
    config,
    options,
    assigned.markdown,
    manifest,
    part,
    items.planned,
  );
  const planned = yield* planSteps({ config, judged, options, part, prd, told }, manifest, items);
  const drafts = draftCountOf(prd, Option.map(part, idsOfPart));
  if (drafts > 0) {
    yield* Console.log(draftWarning(drafts, Option.isSome(part)));
  }
  return {
    ...planned,
    part: Option.match(part, { onNone: () => [], onSome: ({ named }) => named }),
  };
});

/** A dry run: both steps over an in-memory copy of `.cairn/`, then one line of totals. */
const dryRun = Effect.fn("plan.dryRun")(function* (options: PlanOptions) {
  const [elapsed, planned] = yield* Effect.timed(steps(options));
  if (Predicate.isNotUndefined(options.accept)) {
    return;
  }
  const { planner } = yield* configOf(options.planner);
  yield* Console.log(
    totalsLine({
      ...planned,
      agent: planner.source === "api" ? planner.provider : planner.cli,
      model: Option.getOrElse(Option.fromUndefinedOr(planner.model), () => "default"),
      seconds: Number.round(Duration.toSeconds(elapsed), 1),
      source: planner.source,
    }),
  );
});

export const plan = Effect.fn("plan")(function* (options: PlanOptions) {
  if (options.dryRun === true) {
    yield* dryRun(options).pipe(Effect.provide(inMemory));
  } else {
    yield* steps(options);
  }
});

/** The planner of a run that calls none: any call fails, so a wrong `needsPlanner` shows. */
const unusedPlanner = Layer.succeed(
  Planner,
  Planner.of({
    spec: () =>
      Effect.fail(new PlannerError({ call: "spec", reason: "No planner call was expected." })),
    sections: () =>
      Effect.fail(new PlannerError({ call: "sections", reason: "No planner call was expected." })),
    tasks: () =>
      Effect.fail(new PlannerError({ call: "tasks", reason: "No planner call was expected." })),
    splitSection: () =>
      Effect.fail(
        new PlannerError({ call: "splitSection", reason: "No planner call was expected." }),
      ),
    splitTask: () =>
      Effect.fail(new PlannerError({ call: "splitTask", reason: "No planner call was expected." })),
    splitTrunk: () =>
      Effect.fail(new PlannerError({ call: "splitTask", reason: "No planner call was expected." })),
    index: () =>
      Effect.fail(new PlannerError({ call: "index", reason: "No planner call was expected." })),
    statements: () =>
      Effect.fail(
        new PlannerError({ call: "statements", reason: "No planner call was expected." }),
      ),
  }),
);

export const planCommand = Command.make(
  "plan",
  {
    accept: Flag.String("accept").pipe(
      Flag.withDescription(
        "Accept a spec section as it is after its PRD sections changed, and plan nothing",
      ),
      Flag.optional,
    ),
    ids: Argument.String("id").pipe(
      Argument.withDescription(
        "A PRD heading or list item ID to plan with what is under it; none plans the whole PRD",
      ),
      Argument.variadic(),
    ),
    respec: Flag.Boolean("respec").pipe(
      Flag.withDescription(
        "Write the spec again and plan from nothing; refused once a task has left pending",
      ),
      Flag.withDefault(false),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription(
        "Plan in memory: ask nothing, write nothing, and print the totals of the run",
      ),
      Flag.withDefault(false),
    ),
    model: Flag.String("model").pipe(
      Flag.withDescription("Replace planner.model for this run"),
      Flag.optional,
    ),
    provider: Flag.Literals("provider", [
      "anthropic",
      "openai",
      "openrouter",
      "openai-compatible",
    ]).pipe(Flag.withDescription("Replace planner.provider for this run"), Flag.optional),
    source: Flag.Literals("source", ["cli", "api"]).pipe(
      Flag.withDescription("Replace planner.source for this run"),
      Flag.optional,
    ),
    spec: Flag.Boolean("spec").pipe(
      Flag.withDescription("Stop after the spec, without asking"),
      Flag.withDefault(false),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDescription("Answer yes to both questions"),
      Flag.withDefault(false),
    ),
  },
  ({ accept: accepted, ids, model, provider, source, ...flags }) => {
    const options: PlanOptions = {
      ...flags,
      accept: Option.getOrUndefined(accepted),
      part: ids,
      planner: {
        model: Option.getOrUndefined(model),
        provider: Option.getOrUndefined(provider),
        source: Option.getOrUndefined(source),
      },
    };
    return Effect.gen(function* () {
      const config = yield* configOf(options.planner);
      // The model is built only for a run that calls it, so an up-to-date plan needs no CLI or key.
      const planner = Layer.unwrap(
        needsPlanner(options).pipe(
          Effect.map((needed) =>
            needed
              ? Planner.layerWith(config).pipe(Layer.provide(livePlannerModels(config)))
              : unusedPlanner,
          ),
        ),
      );
      // A Judge is provided only when a key or a gateway token is configured; without one the
      // checkpoints find none and are skipped.
      // Git reads the PRD's history, to compare a changed PRD section with the body it had.
      const git = Layer.unwrap(
        Effect.gen(function* () {
          const root = yield* (yield* MainCheckout).root;
          return gitLayer(root);
        }),
      );
      yield* plan(options).pipe(
        Effect.provide(Layer.mergeAll(planner, Judge.whenConfigured(config), git)),
      );
    }).pipe(
      // The failures log their own message once; the runtime does not print them again.
      Effect.tapErrorTag(
        ["RespecRefused", "ManifestRefused", "AcceptRefused", "PlannerRefused"],
        (error) => Effect.logError(error.message),
      ),
      // One line per ID that cannot be planned.
      Effect.tapErrorTag("PartRefused", (error) =>
        Effect.forEach(error.lines, (line) => Console.error(line), { discard: true }),
      ),
    );
  },
).pipe(Command.withDescription("Write spec.md and manifest.json from prd.md, asking after each"));
