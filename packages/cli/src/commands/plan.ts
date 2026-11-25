import { Config as ConfigSchema, Manifest, Slug, SpecSectionId } from "@cairn/contract";
import type { Config as CairnConfig, ManifestTask, Section, SpecIndex } from "@cairn/contract";
import {
  assignSectionIds,
  derivedOf,
  gateOf,
  lint,
  replanOf,
  sectionIdsOf,
  sectionsOf,
  stackOf,
  withStackDiagram,
} from "@cairn/core";
import {
  Array,
  Config,
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
  Predicate,
  Record,
  Ref,
  Result,
  Runtime,
  Schema,
  String,
  Terminal,
} from "effect";
import { Command, Flag } from "effect/cli";

import { MainCheckout } from "../main-checkout.ts";
import { liveLanguageModel } from "../models.ts";
import { Planner, PlannerError } from "../planner.ts";
import { stackLines, totalsLine } from "../print-stack.ts";
import { editedOf, specIndexOf, specIndexText } from "../spec-index.ts";
import { mergeSections } from "../spec-merge.ts";
import {
  CAIRN_DIRECTORY,
  loadConfig,
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

export const JUDGING_SKIPPED = "Judging skipped: TYPESAFE_API_KEY is not set.";
export const UP_TO_DATE = "The plan is up to date.";
export const DRAFT_QUESTION = "Draft tasks from this spec? [y/N]";
export const WRITE_QUESTION = "Write manifest.json? [y/N]";
export const EDIT_SPEC = "Edit .cairn/spec.md, then run cairn plan again.";

/** The branch tasks start from, until the PRD can name another. */
const BASE_BRANCH = "main";

/** The feature a plan has when its PRD's first heading gives no usable name. */
const FALLBACK_FEATURE = Schema.decodeSync(Slug)("plan");

const ManifestJson = Schema.fromJsonString(Manifest, { space: 2 });

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
 */
const inMemory = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const disk = yield* FileSystem.FileSystem;
    const written = yield* Ref.make(HashMap.empty<string, string>());
    const kept = (path: string) => Effect.map(Ref.get(written), HashMap.get(path));
    return {
      ...disk,
      exists: (path) =>
        kept(path).pipe(
          Effect.flatMap(
            Option.match({ onNone: () => disk.exists(path), onSome: () => Effect.succeed(true) }),
          ),
        ),
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
  readonly sections: number;
  readonly tasks: number;
}

const nothingPlanned: Planned = { errors: 0, flags: 0, sections: 0, tasks: 0 };

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
 * The seam for the judging checkpoints (`spec.judging.checkpoints`), reached before the sections
 * and the tasks are written. Without `TYPESAFE_API_KEY` it prints once that judging was skipped.
 * With the key set it has nothing to run yet: the checkpoints plug in here.
 */
const checkpoints = Effect.fn("plan.checkpoints")(function* (told: Ref.Ref<boolean>) {
  const key = yield* Config.String("TYPESAFE_API_KEY").pipe(Config.option);
  const already = yield* Ref.getAndSet(told, true);
  if (Option.isNone(key) && !already) {
    yield* Console.log(JUDGING_SKIPPED);
  }
});

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
  readonly options: PlanOptions;
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

const writeCairn = Effect.fn("plan.write")(function* (name: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  yield* fs.writeFileString(path.join(root, CAIRN_DIRECTORY, name), content);
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
  const { options, prd, told } = inputs;
  const existing = yield* optionally(loadSpec);
  if (options.respec || Option.isNone(existing)) {
    const planner = yield* Planner;
    const drafted = yield* planner.spec(prd);
    yield* checkpoints(told);
    const spec = withNewline(assignSectionIds(drafted, "spec").markdown);
    yield* writeCairn("spec.md", spec);
    const shown = Array.filter(sectionsOf(spec), (section) => Predicate.isNotUndefined(section.id));
    yield* Effect.forEach(shown, (section) => Console.log(sectionLine(section)), {
      discard: true,
    });
    // A respec replaces the manifest too, so the tasks of the one on disk are not the new spec's.
    yield* writeIndex(prd, options.respec ? Option.none() : manifest, {
      changed: [],
      previous: Option.none(),
      written: specIdsOf(spec),
    });
    return { sections: Array.length(shown), wrote: true };
  }
  // Planning again (`spec.planning.again`): the spec exists, so it is added to, never written from nothing.
  const spec = existing.value;
  const index = yield* currentIndex(prd, manifest);
  yield* reportStale(inputs, spec, manifest, index);
  const replan = replanOf(prd, spec, index, manifest);
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
  const fragment = yield* planner.sections(prd, spec, prdSections, replan.rewritable);
  yield* checkpoints(told);
  const merged = mergeSections(spec, fragment, replan.rewritable);
  const next = withNewline(assignSectionIds(merged.markdown, "spec").markdown);
  yield* writeCairn("spec.md", next);
  const before = HashSet.fromIterable<string>(sectionIdsOf(spec));
  const written = Array.appendAll(
    Array.filter(specIdsOf(next), (id) => !HashSet.has(before, id)),
    merged.rewritten,
  );
  const added = HashSet.fromIterable<string>(written);
  const printed = Array.filter(
    sectionsOf(next),
    (section) => Predicate.isNotUndefined(section.id) && HashSet.has(added, section.id),
  );
  yield* Effect.forEach(printed, (section) => Console.log(sectionLine(section)), {
    discard: true,
  });
  yield* writeIndex(prd, manifest, {
    changed: editedOf(next, index),
    previous: Option.some(index),
    written,
  });
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
  { options, prd }: Inputs,
  manifest: Option.Option<Manifest>,
) {
  const spec = yield* loadSpec;
  if (options.respec || Option.isNone(manifest)) {
    return Option.some<ReadonlyArray<SpecSectionId>>(specIdsOf(spec));
  }
  const index = yield* currentIndex(prd, manifest);
  return Option.map(
    Option.liftPredicate(
      replanOf(prd, spec, index, manifest).untasked,
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
  { config, options, prd, told }: Inputs,
  manifest: Option.Option<Manifest>,
  specSections: ReadonlyArray<SpecSectionId>,
) {
  const planner = yield* Planner;
  const spec = yield* loadSpec;
  yield* checkpoints(told);
  // `--respec` plans from nothing; otherwise the tasks in the manifest stay as they are.
  const kept = options.respec ? Option.none<Manifest>() : manifest;
  const existing = tasksOf(kept);
  const drafts = yield* planner.tasks(prd, spec, specSections, existing);
  const sections = Array.appendAll(sectionsOf(prd), sectionsOf(spec));
  const feature = Option.match(kept, {
    onNone: () => featureOf(prd),
    onSome: (plan) => plan.feature,
  });
  const ordered = yield* Effect.fromResult(
    stackOf(feature, drafts, (draft) => gateOf(draft, sections, config, []), existing),
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
  const findings = lint(prd, drawn, Option.some(drafted), config);
  const old = HashSet.fromIterable(Array.map(existing, (task) => task.id));
  yield* Effect.forEach(
    Array.appendAll(
      stackLines(drafted.tasks, { isNew: (task) => !HashSet.has(old, task.id) }),
      Array.map(findings, formatFinding),
    ),
    (line) => Console.log(line),
    { discard: true },
  );
  const errors = Array.length(Array.filter(findings, (finding) => finding.severity === "error"));
  // The judging checkpoints (`spec.judging.checkpoints`) have nothing to flag yet.
  const planned: Planned = { errors, flags: 0, sections: 0, tasks: added };
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
  const prd = assignSectionIds(prdText, "prd").markdown;
  return Option.match(Option.all({ index, spec }), {
    onNone: () => true,
    onSome: ({ index: written, spec: text }) => {
      const replan = replanOf(prd, text, written, manifest);
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

/**
 * Runs the two steps of `cairn plan` (`spec.planning.cairn-plan`): the spec, then the tasks, each
 * followed by a question. On a plan that has a spec or tasks already it plans again
 * (`spec.planning.again`): spec sections for PRD sections nothing covers, tasks for spec sections
 * nothing builds, and a report of what went stale; no task in the manifest changes. The judging
 * checkpoints and `judgments.json` belong to the tasks that own them.
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
  const prdText = yield* loadPrd;
  const assigned = assignSectionIds(prdText, "prd");
  if (Array.isReadonlyArrayNonEmpty(assigned.added)) {
    yield* writeCairn("prd.md", assigned.markdown);
    yield* Effect.forEach(assigned.added, (id) => Console.log(`Added ${id}`), { discard: true });
  }
  const inputs: Inputs = { config, options, prd: assigned.markdown, told };

  const { sections, wrote: specWritten } = yield* specStep(inputs, manifest);
  const toDraft = options.spec ? Option.none() : yield* draftable(inputs, manifest);
  if (Option.isNone(toDraft)) {
    // A manifest on disk keeps its diagram true, so a spec that drifted from it is drawn again.
    if (!specWritten && !(yield* redraw(inputs.prd, manifest))) {
      yield* Console.log(UP_TO_DATE);
    }
    return { ...nothingPlanned, sections };
  }
  const proceed = specWritten
    ? yield* confirm(DRAFT_QUESTION, options.yes || options.dryRun === true)
    : true;
  if (proceed) {
    const planned = yield* tasksStep(inputs, manifest, toDraft.value);
    return { ...planned, sections };
  }
  yield* Console.log(EDIT_SPEC);
  return { ...nothingPlanned, sections };
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
    index: () =>
      Effect.fail(new PlannerError({ call: "index", reason: "No planner call was expected." })),
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
  ({ accept: accepted, model, provider, source, ...flags }) => {
    const options: PlanOptions = {
      ...flags,
      accept: Option.getOrUndefined(accepted),
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
              ? Planner.layerWith(config).pipe(Layer.provide(liveLanguageModel(config)))
              : unusedPlanner,
          ),
        ),
      );
      yield* plan(options).pipe(Effect.provide(planner));
    }).pipe(
      // The failures log their own message once; the runtime does not print them again.
      Effect.tapErrorTag(
        ["RespecRefused", "ManifestRefused", "AcceptRefused", "PlannerRefused"],
        (error) => Effect.logError(error.message),
      ),
    );
  },
).pipe(Command.withDescription("Write spec.md and manifest.json from prd.md, asking after each"));
