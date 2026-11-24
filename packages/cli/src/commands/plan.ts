import { Manifest, Slug } from "@cairn/contract";
import type { Config as CairnConfig, Section } from "@cairn/contract";
import { assignSectionIds, gateOf, lint, sectionsOf, stackOf } from "@cairn/core";
import {
  Array,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
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
import { stackLines } from "../print-stack.ts";
import { CAIRN_DIRECTORY, loadConfig, loadManifest, loadPrd, loadSpec } from "../workspace.ts";
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

/** What `cairn plan` was asked: `--spec`, `--yes` and `--respec`. */
export interface PlanOptions {
  readonly respec: boolean;
  readonly spec: boolean;
  readonly yes: boolean;
}

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

/** Step 1: writes `spec.md` from the PRD and prints its sections. Returns whether it wrote. */
const specStep = Effect.fn("plan.specStep")(function* ({ options, prd, told }: Inputs) {
  const existing = yield* optionally(loadSpec);
  if (!options.respec && Option.isSome(existing)) {
    return false;
  }
  const planner = yield* Planner;
  const drafted = yield* planner.spec(prd);
  yield* checkpoints(told);
  const spec = withNewline(assignSectionIds(drafted, "spec").markdown);
  yield* writeCairn("spec.md", spec);
  yield* Effect.forEach(
    Array.filter(sectionsOf(spec), (section) => Predicate.isNotUndefined(section.id)),
    (section) => Console.log(sectionLine(section)),
    { discard: true },
  );
  return true;
});

/** Step 2: drafts the tasks from the spec on disk, orders and lints them, and writes `manifest.json` when the person agrees. */
const tasksStep = Effect.fn("plan.tasksStep")(function* ({ config, options, prd, told }: Inputs) {
  const planner = yield* Planner;
  const spec = yield* loadSpec;
  yield* checkpoints(told);
  const drafts = yield* planner.tasks(prd, spec);
  const sections = Array.appendAll(sectionsOf(prd), sectionsOf(spec));
  const feature = featureOf(prd);
  const ordered = yield* Effect.fromResult(
    stackOf(feature, drafts, (draft) => gateOf(draft, sections, config, [])),
  );
  const tasks = yield* Effect.filterOrFail(
    Effect.succeed(ordered),
    Array.isReadonlyArrayNonEmpty,
    () => new PlannerError({ call: "tasks", reason: "The planner drafted no tasks." }),
  );
  const drafted: Manifest = { baseBranch: BASE_BRANCH, feature, tasks, version: 1 };
  const findings = lint(prd, spec, Option.some(drafted), config);
  yield* Effect.forEach(
    Array.appendAll(
      stackLines(drafted.tasks, { isNew: () => true }),
      Array.map(findings, formatFinding),
    ),
    (line) => Console.log(line),
    { discard: true },
  );
  const errors = Array.length(Array.filter(findings, (finding) => finding.severity === "error"));
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
  }
});

/** The IDs of the tasks that have left `pending`. */
const startedOf = (manifest: Option.Option<Manifest>) =>
  Option.match(manifest, {
    onNone: () => [],
    onSome: (existing) =>
      Array.filterMap(existing.tasks, (task) =>
        task.status === "pending" ? Result.failVoid : Result.succeed(task.id),
      ),
  });

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
  const manifest = yield* optionally(loadManifest);
  yield* refuseRestart(options, manifest);
  const spec = yield* optionally(loadSpec);
  const generating = options.respec || Option.isNone(spec);
  const drafting = (options.respec || Option.isNone(manifest)) && !options.spec;
  return generating || drafting;
});

/**
 * Runs the two steps of `cairn plan` (`spec.planning.cairn-plan`): the spec, then the tasks, each
 * followed by a question. Planning again on a plan that has a manifest (`spec.planning.again`),
 * `spec.json` (`spec.contract.spec-index`), the stack diagram and `judgments.json` belong to
 * the tasks that own them; this writes `prd.md` IDs, `spec.md` and `manifest.json`.
 */
export const plan = Effect.fn("plan")(function* (options: PlanOptions) {
  const manifest = yield* optionally(loadManifest);
  yield* refuseRestart(options, manifest);

  const config = yield* loadConfig;
  const told = yield* Ref.make(false);
  const prdText = yield* loadPrd;
  const assigned = assignSectionIds(prdText, "prd");
  if (Array.isReadonlyArrayNonEmpty(assigned.added)) {
    yield* writeCairn("prd.md", assigned.markdown);
    yield* Effect.forEach(assigned.added, (id) => Console.log(`Added ${id}`), { discard: true });
  }
  const inputs: Inputs = { config, options, prd: assigned.markdown, told };

  const specWritten = yield* specStep(inputs);
  // Adding to a plan that already has tasks is planning again, which this does not do yet.
  const tasksToDraft = options.respec || Option.isNone(manifest);
  if (options.spec || !(specWritten || tasksToDraft)) {
    if (!specWritten) {
      yield* Console.log(UP_TO_DATE);
    }
  } else if (tasksToDraft) {
    const proceed = specWritten ? yield* confirm(DRAFT_QUESTION, options.yes) : true;
    if (proceed) {
      yield* tasksStep(inputs);
    } else {
      yield* Console.log(EDIT_SPEC);
    }
  }
});

/** The planner of a run that calls none: any call fails, so a wrong `needsPlanner` shows. */
const unusedPlanner = Layer.succeed(
  Planner,
  Planner.of({
    spec: () =>
      Effect.fail(new PlannerError({ call: "spec", reason: "No planner call was expected." })),
    tasks: () =>
      Effect.fail(new PlannerError({ call: "tasks", reason: "No planner call was expected." })),
  }),
);

export const planCommand = Command.make(
  "plan",
  {
    respec: Flag.Boolean("respec").pipe(
      Flag.withDescription(
        "Write the spec again and plan from nothing; refused once a task has left pending",
      ),
      Flag.withDefault(false),
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
  (options) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
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
      Effect.tapErrorTag(["RespecRefused", "ManifestRefused"], (error) =>
        Effect.logError(error.message),
      ),
    ),
).pipe(Command.withDescription("Write spec.md and manifest.json from prd.md, asking after each"));
