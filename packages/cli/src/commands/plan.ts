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
  ManifestTask,
  Section,
  SpecIndex,
  TaskDraft,
} from "@cairn/contract";
import {
  assignItemIds,
  assignSectionIds,
  conflictOrder,
  conflictsOf,
  derivedOf,
  gateOf,
  historyOf,
  hotspotsOf,
  inputsOf,
  itemsOf,
  lint,
  orderingOf,
  orderingsOf,
  partOf,
  refusalOf,
  replanOf,
  scopeOf,
  sectionIdsOf,
  sectionsOf,
  stackOf,
  uncoveredItemsOf,
  uncoveredOf,
  withStackDiagram,
} from "@cairn/core";
import type { Conflict, Finding, Hotspot, Part, Replan, StackOrderError } from "@cairn/core";
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
  pipe,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  askStatements,
  draftCountOf,
  draftStatements,
  draftWarning,
  targetsOf,
} from "../ask-statements.ts";
import { replaceFile } from "../atomic-write.ts";
import { Git } from "../git.ts";
import { layer as gitLayer } from "../git-live.ts";
import { Judge, JudgeError } from "../judge.ts";
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

/** The person's answer to `question`, trimmed and in lowercase; the end of input is `""`. `--yes` answers `yes` without asking. */
const reply = Effect.fn("plan.reply")(function* (question: string, yes: boolean) {
  if (yes) {
    return "yes";
  }
  const terminal = yield* Terminal.Terminal;
  yield* terminal.display(`${question} `);
  const answer = yield* terminal.readLine.pipe(
    Effect.catchTag("QuitError", () => Effect.succeed("")),
  );
  return String.toLowerCase(String.trim(answer));
});

/** Whether an answer is a yes: `y` or `yes`. Anything else, and the end of input, is no. */
const isYes = (answer: string) => Array.contains(["y", "yes"], answer);

/** A yes or no from the person. `--yes` answers yes without asking. */
const confirm = (question: string, yes: boolean) => Effect.map(reply(question, yes), isYes);

/** The ordering `undo <n>` names at the task review (`spec.planning.conflict-ordering`). */
const undoOf = (answer: string): Option.Option<number> =>
  pipe(
    answer,
    String.match(/^undo\s+(\d+)$/u),
    Option.flatMap(Array.get(1)),
    Option.flatMap(Number.parse),
  );

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
 * `replanOf` has no item mapping yet (`spec.planning.again`), so a part run reads the items here,
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

/**
 * The fourth checkpoint, the stack questions (`spec.judging.checkpoints`): asked of the manifest
 * the plan would write, and `splitFile` of each file in `hotspots` (`spec.planning.conflict-ordering`).
 * It only reports. A part run's `complete` question lists only the part's PRD sections.
 */
const stackJudged = Effect.fn("plan.stackJudged")(function* (
  { config, part, told }: Inputs,
  prd: string,
  spec: string,
  manifest: Manifest,
  hotspots: ReadonlyArray<Hotspot>,
) {
  const none: ReadonlyArray<Judgment> = [];
  const maybeJudge = yield* judging(told);
  return yield* Option.match(maybeJudge, {
    onNone: () => Effect.succeed(none),
    onSome: (judge) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* (yield* MainCheckout).root;
        const titles = HashMap.fromIterable(
          Array.map(manifest.tasks, (task) => [task.id, task.title] as const),
        );
        // Each shared file with its line count; a file the plan creates is not there yet and has none.
        const files = yield* Effect.forEach(hotspots, (hotspot) =>
          fs.readFileString(path.join(root, hotspot.path)).pipe(
            Effect.map((text) => Array.length(String.split(text, "\n"))),
            Effect.orElseSucceed(() => 0),
            Effect.map((lines) => ({
              input: {
                lines,
                path: hotspot.path,
                tasks: Array.getSomes(Array.map(hotspot.tasks, (id) => HashMap.get(titles, id))),
              },
              path: hotspot.path,
            })),
          ),
        );
        const whole = inputsOf(prd, spec, manifest).stack;
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
        return yield* judge
          .judge(
            { files, sections: [], stack, tasks: [] },
            { judgments: [], model: config.judge.model, version: 1 },
          )
          .pipe(
            Effect.map(({ judgments }) =>
              Array.filter(
                judgments,
                (judgment) => judgment.target.kind === "stack" || judgment.target.kind === "file",
              ),
            ),
            Effect.catchTag("JudgeError", failedAs(none)),
          );
      }),
  });
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
}

/** Writes `spec.json` for the `spec.md` on disk (`spec.contract.spec-index`). */
const writeIndex = Effect.fn("plan.writeIndex")(function* (
  prd: string,
  manifest: Option.Option<Manifest>,
  { changed, previous, written }: IndexChange,
) {
  const spec = yield* loadSpec;
  const index = yield* specIndexOf({
    changed,
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

/** Step 1: writes `spec.md` from the PRD and prints its sections. Returns whether it wrote and how many sections it printed. */
const specStep = Effect.fn("plan.specStep")(function* (
  inputs: Inputs,
  manifest: Option.Option<Manifest>,
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
  const spec = Option.getOrElse(existing, () => specStartOf(prd));
  const index = started ? NO_INDEX : yield* indexFor(part, prd, manifest);
  yield* reportStale(inputs, spec, manifest, index);
  const whole = replanOf(prd, spec, index, manifest);
  const replan = narrowed(part, whole, prd, spec, index);
  yield* reportMoved(spec, whole, replan);
  if (
    Array.isReadonlyArrayEmpty(replan.uncovered) &&
    Array.isReadonlyArrayEmpty(replan.rewritable)
  ) {
    return { sections: 0, wrote: false };
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

/** A stack the task review shows: the manifest it would write, its spec, and what lint found. */
interface Reviewed {
  readonly drafted: Manifest;
  readonly drawn: string;
  readonly findings: ReadonlyArray<Finding>;
  /** Findings about what a part run leaves for later, which do not stop its write. */
  readonly later: ReadonlyArray<Finding>;
}

const noTasks = () => new PlannerError({ call: "tasks", reason: "The planner drafted no tasks." });

const printed = (lines: ReadonlyArray<string>) =>
  Effect.forEach(lines, (line) => Console.log(line), { discard: true });

/**
 * What the base branch's history says about its files, for the conflict scores
 * (`spec.planning.conflict-scores`). A repository git cannot read, such as one with no commit on
 * the base branch yet, has no history: every file then counts as one that rarely changes.
 */
const historyFor = Effect.fn("plan.history")(function* (baseBranch: string, config: CairnConfig) {
  const git = yield* Git;
  return yield* git.history(baseBranch, config.conflicts.history).pipe(
    Effect.map(historyOf),
    Effect.catchTag("GitError", (error) =>
      Console.log(`Conflict history skipped: ${error.message}`).pipe(Effect.as(historyOf([]))),
    ),
  );
});

/** A pair as the conflicts block names it: the earlier task first. */
const pairOf = ({ earlier, later }: Conflict) => `${earlier} ↔ ${later}`;

/** How many of a stack's lint findings are errors, which refuse the write. */
const errorsOf = (state: Reviewed) =>
  Array.length(Array.filter(state.findings, (finding) => finding.severity === "error"));

/**
 * The conflicts block of the plan output (`spec.planning.conflict-ordering`): each high-scoring
 * pair, numbered for `undo <n>`, with its score, its reasons and what was done about it. None
 * when no pair scores high.
 */
const conflictLines = (
  conflicts: ReadonlyArray<Conflict>,
  stacked: ReadonlyArray<Conflict>,
): ReadonlyArray<string> => {
  const width = Array.reduce(conflicts, 0, (widest, conflict) =>
    Number.max(widest, String.length(pairOf(conflict))),
  );
  return Array.match(conflicts, {
    onEmpty: () => [],
    onNonEmpty: (listed) =>
      Array.prepend(
        Array.map(listed, (conflict, at) => {
          const done = Array.contains(stacked, conflict)
            ? `stacked ${conflict.later} on ${conflict.earlier}`
            : `recommend starting ${conflict.later} after ${conflict.earlier} lands`;
          return `  ${at + 1}  ${String.padEnd(width)(pairOf(conflict))}  ${conflict.score.score.toFixed(2)}  ${conflict.reason}: ${done}`;
        }),
        "conflicts",
      ),
  });
};

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
  const baseBranch = Option.match(kept, {
    onNone: () => BASE_BRANCH,
    onSome: (plan) => plan.baseBranch,
  });
  const gates = (draft: TaskDraft) => gateOf(draft, sections, config, [], items);
  // What a part run leaves for later does not stop its write: it is listed apart from what does.
  const inPart = Option.map(part, idsOfPart);
  const isLater = (finding: Finding) => Option.exists(inPart, (ids) => notPlannedYet(ids, finding));
  const reviewed = (ordered: Array.NonEmptyReadonlyArray<ManifestTask>): Reviewed => {
    const drafted: Manifest = { baseBranch, feature, tasks: ordered, version: 1 };
    // Every manifest write draws the stack diagram again, so lint reads the spec as it will be written.
    const drawn = withStackDiagram(spec, drafted);
    const found = lint(prd, drawn, Option.some(drafted), config);
    return {
      drafted,
      drawn,
      findings: Array.filter(found, (finding) => !isLater(finding)),
      later: Array.filter(found, isLater),
    };
  };
  /** The stack with `stacked` applied as conflict orderings; the drafts were placed once already, so it cannot fail. */
  const restacked = (stacked: ReadonlyArray<Conflict>) =>
    Effect.fromResult(
      stackOf(feature, drafts, gates, existing, Array.map(stacked, orderingOf)),
    ).pipe(Effect.filterOrFail(Array.isReadonlyArrayNonEmpty, noTasks), Effect.map(reviewed));
  const unordered = yield* Effect.fromResult(stackOf(feature, drafts, gates, existing));
  const fresh = Array.drop(unordered, Array.length(existing));
  yield* Effect.filterOrFail(Effect.succeed(fresh), Array.isReadonlyArrayNonEmpty, noTasks);
  const added = Array.length(fresh);
  // High-scoring pairs among the new tasks are stacked or recommended before the stack is shown.
  const history = yield* historyFor(baseBranch, config);
  const orderings = orderingsOf(
    fresh,
    existing,
    conflictsOf(existing, fresh, history, config.conflicts),
    config.conflicts,
  );
  const conflicts = Array.sort(
    Array.appendAll(orderings.applied, orderings.recommended),
    conflictOrder,
  );
  const first = yield* restacked(orderings.applied);
  // A judgment of a draft that became a task is named by the task's ID; one of a draft a split
  // replaced stays named by its title.
  const ids = HashMap.fromIterable(Array.map(fresh, (task) => [task.title, task.id] as const));
  const stack = yield* stackJudged(
    inputs,
    prd,
    first.drawn,
    first.drafted,
    hotspotsOf(existing, fresh, config.conflicts),
  );
  const judgments = Array.appendAll(
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
  yield* record(inputs, judgments);
  const old = HashSet.fromIterable(Array.map(existing, (task) => task.id));
  const shown = (state: Reviewed) =>
    Array.flatten([
      stackLines(state.drafted.tasks, { isNew: (task) => !HashSet.has(old, task.id) }),
      Array.map(state.findings, formatFinding),
      Array.match(state.later, {
        onEmpty: () => [],
        onNonEmpty: (left) => Array.prepend(Array.map(left, formatFinding), NOT_PLANNED_YET),
      }),
    ]);
  yield* printed(
    Array.flatten([
      partLines(part),
      changeLines(judgments),
      conflictLines(conflicts, orderings.applied),
      shown(first),
      reportLines(judgments),
    ]),
  );
  const everything = yield* Ref.get(judged);
  const planned: Omit<Planned, "part"> = {
    errors: errorsOf(first),
    flags: flagsOf(everything),
    sections: 0,
    tasks: added,
  };
  if (options.dryRun === true) {
    return planned;
  }
  // The task review: a yes writes, `undo <n>` takes stacking `n` back out and asks again.
  const review = Effect.fn("plan.review")(function* (
    state: Reviewed,
    stacked: ReadonlyArray<Conflict>,
  ): Effect.fn.Return<
    Option.Option<Reviewed>,
    ManifestRefused | PlannerError | PlatformError.PlatformError | StackOrderError,
    Terminal.Terminal
  > {
    yield* Effect.filterOrFail(
      Effect.succeed(errorsOf(state)),
      (count) => count === 0,
      (count) => new ManifestRefused({ errors: count }),
    );
    const answer = yield* reply(WRITE_QUESTION, options.yes);
    if (isYes(answer)) {
      return Option.some(state);
    }
    return yield* Option.match(undoOf(answer), {
      onNone: () => Effect.succeed(Option.none<Reviewed>()),
      onSome: (n) =>
        Option.match(
          Option.filter(Array.get(conflicts, n - 1), (conflict) =>
            Array.contains(stacked, conflict),
          ),
          {
            onNone: () =>
              Console.log(`There is no stacking ${n} to undo.`).pipe(
                Effect.andThen(review(state, stacked)),
              ),
            onSome: (undone) => {
              const left = Array.filter(stacked, (conflict) => conflict !== undone);
              return restacked(left).pipe(
                Effect.tap((next) =>
                  printed(
                    Array.prepend(
                      shown(next),
                      `Undid ${n}: ${undone.later} no longer stacks on ${undone.earlier}.`,
                    ),
                  ),
                ),
                Effect.flatMap((next) => review(next, left)),
              );
            },
          },
        ),
    });
  });
  const chosen = yield* review(first, orderings.applied);
  if (Option.isSome(chosen)) {
    const { drafted, drawn } = chosen.value;
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
      return (
        Array.isReadonlyArrayNonEmpty(replan.uncovered) ||
        Array.isReadonlyArrayNonEmpty(replan.rewritable) ||
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
  options: PlanOptions,
  prd: string,
  manifest: Option.Option<Manifest>,
  part: Option.Option<Part>,
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
              replanFor(part, prd, text, index, manifest).uncovered,
            ),
          ),
  });
  const drafted = yield* draftStatements(prd, targetsOf(prd, only), savePrd);
  return yield* askStatements(drafted, options, savePrd, Option.map(part, idsOfPart));
});

/** The spec and the tasks: what `steps` does once the PRD's statements are settled. */
const planSteps = Effect.fn("plan.planSteps")(function* (
  inputs: Inputs,
  manifest: Option.Option<Manifest>,
) {
  const { options } = inputs;
  const { sections, wrote: specWritten } = yield* specStep(inputs, manifest);
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
  const prd = yield* statementsStep(options, assigned.markdown, manifest, part);
  const planned = yield* planSteps({ config, judged, options, part, prd, told }, manifest);
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
      // Git is read in the main checkout, for the history the conflict scores weigh files by.
      const git = Layer.unwrap(
        Effect.gen(function* () {
          const root = yield* (yield* MainCheckout).root;
          return gitLayer(root);
        }),
      );
      // A Judge is provided only when a key or a gateway token is configured; without one the
      // checkpoints find none and are skipped.
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
