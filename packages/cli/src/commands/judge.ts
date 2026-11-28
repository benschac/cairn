import { JudgmentTarget, Judgments } from "@cairn/contract";
import type { Config, Judgment, Manifest, ManifestTask } from "@cairn/contract";
import { hotspotsOf, inputsOf, sectionsOf, verdictOf } from "@cairn/core";
import {
  Array,
  Console,
  Effect,
  FileSystem,
  HashMap,
  Option,
  Path,
  Runtime,
  Schema,
  String,
  Struct,
} from "effect";
import { Command, Flag } from "effect/cli";

import { replaceFile } from "../atomic-write.ts";
import { Judge, fileInputsOf } from "../judge.ts";
import { MainCheckout } from "../main-checkout.ts";
import { CAIRN_DIRECTORY, loadConfig, loadManifest, loadPrd, loadSpec } from "../workspace.ts";

/** `cairn judge --strict` found a `flag`. */
export class JudgeFlagged extends Schema.TaggedError<
  JudgeFlagged,
  { readonly brand: unique symbol }
>()("JudgeFlagged", { flags: Schema.Int }) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `cairn judge found ${this.flags} ${this.flags === 1 ? "flag" : "flags"}`;
  }
}

/** What `judgePlan` takes: the two flags of `cairn judge`. */
export interface JudgeOptions {
  /** Ignore previous judgments and ask again. */
  readonly fresh: boolean;
  /** Fail with `JudgeFlagged` when any judgment is a `flag`. */
  readonly strict: boolean;
}

const JudgmentsFile = Schema.fromJsonString(Judgments, { space: 2 });

/** `.cairn/judgments.json` as the file holds it: indented JSON ending in a newline. */
const judgmentsText = (judgments: Judgments) =>
  Schema.encodeEffect(JudgmentsFile)(judgments).pipe(
    Effect.map((text) => (String.endsWith("\n")(text) ? text : `${text}\n`)),
  );

/** The `judgments.json` on disk, or none when there is not one. */
const loadJudgments = Effect.fn("judge.loadJudgments")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  const file = path.join(root, CAIRN_DIRECTORY, "judgments.json");
  const present = yield* fs.exists(file);
  return present
    ? yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeEffect(JudgmentsFile)), Effect.asSome)
    : Option.none<Judgments>();
});

/** The manifest task a target names, none for any other target. */
const taskOf = (target: JudgmentTarget, manifest: Manifest): Option.Option<ManifestTask> =>
  JudgmentTarget.match(target, {
    draft: () => Option.none(),
    file: () => Option.none(),
    section: () => Option.none(),
    stack: () => Option.none(),
    task: ({ id }) => Array.findFirst(manifest.tasks, (task) => task.id === id),
  });

/**
 * A judgment's verdict and message under the current thresholds, from its answer alone, so a
 * kept judgment follows a changed `judge.pass`, `judge.flag` or `judge.minConfidence`. A
 * task's `model` and `reasoning` answers are compared with the manifest's task, which `Judge`
 * does not see: a confident answer that differs is a `flag`. A judgment that split or routed
 * keeps what the checkpoint wrote.
 */
const reverdicted = (
  judgment: Judgment,
  manifest: Manifest,
  thresholds: Config["judge"],
): Judgment => {
  const task = Option.filter(
    taskOf(judgment.target, manifest),
    () => judgment.question === "model" || judgment.question === "reasoning",
  );
  const { message, verdict } = verdictOf(
    judgment.question,
    judgment.answer,
    thresholds,
    Option.getOrUndefined(task),
  );
  return judgment.action === "none"
    ? Struct.evolve(judgment, { message: () => message, verdict: () => verdict })
    : judgment;
};

/**
 * Where a judgment points: a section or the task's first spec section in `spec.md`, a file's own
 * path, else the manifest.
 */
const placeOf = (
  { target }: Judgment,
  manifest: Manifest,
  lines: HashMap.HashMap<string, number>,
): string => {
  if (target.kind === "file") {
    return target.path;
  }
  const specSection = JudgmentTarget.match(target, {
    draft: () => Option.none<string>(),
    file: () => Option.none<string>(),
    section: ({ id }) => Option.some<string>(id),
    stack: () => Option.none<string>(),
    task: () =>
      Option.flatMap(taskOf(target, manifest), ({ specSections }) => Array.head(specSections)),
  });
  return Option.match(
    Option.flatMap(specSection, (id) => HashMap.get(lines, id)),
    {
      onNone: () => `${CAIRN_DIRECTORY}/manifest.json`,
      onSome: (line) => `${CAIRN_DIRECTORY}/spec.md:${line}`,
    },
  );
};

/** A judgment as `cairn judge` prints it: `file:line judge:<question> <verdict> <message>`. */
export const formatJudgment = (
  judgment: Judgment,
  manifest: Manifest,
  lines: HashMap.HashMap<string, number>,
): string =>
  `${placeOf(judgment, manifest, lines)} judge:${judgment.question} ${judgment.verdict} ${judgment.message}`;

/**
 * Judges the spec and manifest in `.cairn/` (`spec.judging.cairn-judge`), writes
 * `judgments.json` and prints a line per `flag` or `unsure`. It changes nothing else. Previous
 * judgments are reused unless `fresh`. With `strict`, a `flag` fails with `JudgeFlagged`, after
 * the file is written. Returns the judgments.
 */
export const judgePlan = Effect.fn("judgePlan")(function* (options: JudgeOptions) {
  const judge = yield* Judge;
  const prd = yield* loadPrd;
  const spec = yield* loadSpec;
  const manifest = yield* loadManifest;
  const config = yield* loadConfig;
  const previous = options.fresh ? Option.none<Judgments>() : yield* loadJudgments();
  // The files the plan asked `separable` about, from the manifest's open tasks, so their
  // judgments are kept and asked again when the file or its tasks change.
  const files = yield* fileInputsOf(
    hotspotsOf(manifest.tasks, [], config.conflicts),
    manifest.tasks,
    spec,
  );
  const judged = yield* judge.judge(
    Struct.evolve(inputsOf(prd, spec, manifest), { files: () => files }),
    Option.getOrElse(previous, (): Judgments => ({
      judgments: [],
      model: config.judge.model,
      version: 1,
    })),
  );
  const judgments = Struct.evolve(judged, {
    judgments: (all) => Array.map(all, (judgment) => reverdicted(judgment, manifest, config.judge)),
  });

  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  const text = yield* judgmentsText(judgments);
  yield* replaceFile(path.join(root, CAIRN_DIRECTORY, "judgments.json"), text);

  const lines = HashMap.fromIterable(
    Array.getSomes(
      Array.map(sectionsOf(spec), (section) =>
        Option.map(Option.fromUndefinedOr(section.id), (id) => [id, section.line] as const),
      ),
    ),
  );
  const reported = Array.filter(judgments.judgments, ({ verdict }) => verdict !== "pass");
  yield* Effect.forEach(
    reported,
    (judgment) => Console.log(formatJudgment(judgment, manifest, lines)),
    {
      discard: true,
    },
  );

  const flags = Array.length(Array.filter(reported, ({ verdict }) => verdict === "flag"));
  return options.strict && flags > 0 ? yield* new JudgeFlagged({ flags }) : judgments;
});

export const judgeCommand = Command.make(
  "judge",
  {
    fresh: Flag.Boolean("fresh").pipe(
      Flag.withDescription("Ignore previous judgments and ask again"),
      Flag.withDefault(false),
    ),
    strict: Flag.Boolean("strict").pipe(
      Flag.withDescription("Exit 1 when any judgment is a flag"),
      Flag.withDefault(false),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      yield* judgePlan(options).pipe(Effect.provide(Judge.live(config)));
    }).pipe(
      // The failure logs its own message once; the runtime does not print it again.
      Effect.tapErrorTag("JudgeFlagged", (error) => Effect.logError(error.message)),
    ),
).pipe(Command.withDescription("Judge the spec and manifest again and write judgments.json"));
