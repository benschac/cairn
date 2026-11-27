import { JudgmentsJson, Manifest, TaskDraft } from "@cairn/contract";
import type { Judgment } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Predicate,
  Record,
  Ref,
  Result,
  Schema,
  Scope,
  String,
  Struct,
} from "effect";
import { TestConsole } from "effect/testing";

import {
  DRAFT_QUESTION,
  EDIT_SPEC,
  JUDGING_SKIPPED,
  ManifestRefused,
  needsPlanner,
  plan,
  RespecRefused,
  UP_TO_DATE,
  WRITE_QUESTION,
} from "../src/commands/plan.ts";
import { Judge, JudgeError } from "../src/judge.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { Planner } from "../src/planner.ts";
import { targetName } from "../src/print-judgments.ts";
import { scriptedTerminal } from "./fixtures/scripted-terminal.ts";
import { scriptedJudge } from "./scripted-judge.ts";
import type { Script } from "./scripted-judge.ts";
import { stubPlanner } from "./fixtures/stub-planner.ts";

const PRD = "# Notes\n\n## Capture\n\nKeep a note.\n";

const SPEC =
  "# Spec\n\n## Capture\n\n- Implements: `prd.capture`\n- Files: `src/capture.ts`\n\nKeep a note.\n";

const draft = (title: string, specSection: string) =>
  Schema.decodeSync(TaskDraft)({
    category: "feature",
    dependsOn: [],
    files: ["src/capture.ts"],
    model: "sonnet",
    prdSections: ["prd.capture"],
    reasoning: "high",
    specSections: [specSection],
    title,
  });

const DRAFTS = [draft("Add capture", "spec.capture")];

/** What the scripted planner was asked, and what the person was asked and answered. */
class Seen extends Context.Service<
  Seen,
  {
    readonly shown: Ref.Ref<ReadonlyArray<string>>;
    readonly specs: Ref.Ref<ReadonlyArray<string>>;
    readonly tasks: Ref.Ref<ReadonlyArray<{ readonly prd: string; readonly spec: string }>>;
  }
>()("@cairn/cli/test/Seen") {}

/** A planner that answers `spec` with `markdown` and `tasks` with `drafts`, and remembers each call. */
const scriptedPlanner = (
  markdown: string,
  drafts: ReadonlyArray<TaskDraft>,
  split: (draft: TaskDraft) => ReadonlyArray<TaskDraft>,
) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const seen = Seen.of({
        shown: yield* Ref.make<ReadonlyArray<string>>([]),
        specs: yield* Ref.make<ReadonlyArray<string>>([]),
        tasks: yield* Ref.make<ReadonlyArray<{ readonly prd: string; readonly spec: string }>>([]),
      });
      const planner = stubPlanner({
        spec: (prd) => Ref.update(seen.specs, Array.append(prd)).pipe(Effect.as(markdown)),
        tasks: (prd, spec) =>
          Ref.update(seen.tasks, Array.append({ prd, spec })).pipe(Effect.as(drafts)),
        splitTask: (whole) => Effect.succeed(split(whole)),
      });
      return Context.make(Seen, seen).pipe(Context.add(Planner, planner));
    }),
  );

interface Plan {
  readonly answers?: ReadonlyArray<string>;
  readonly drafts?: ReadonlyArray<TaskDraft>;
  /** The judge of the run: none provides no `Judge`, as `cairn plan` does without a key. */
  readonly judge?: Layer.Layer<Judge> | typeof Layer.empty;
  readonly options?: {
    readonly dryRun?: boolean;
    readonly respec?: boolean;
    readonly spec?: boolean;
    readonly yes?: boolean;
  };
  readonly spec?: string;
  /** What `Planner.splitTask` answers. */
  readonly split?: (draft: TaskDraft) => ReadonlyArray<TaskDraft>;
}

const NAMES = ["prd.md", "spec.md", "manifest.json", "judgments.json"] as const;

/** A repository root whose `.cairn/` holds the given files, and a way to run `cairn plan` in it. */
const setup = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, ".cairn"));
    yield* Effect.forEach(
      Record.toEntries(files),
      ([name, content]) => fs.writeFileString(path.join(root, ".cairn", name), content),
      { discard: true },
    );
    /** A file of `.cairn/`: none when it is not there. */
    const read = (name: string) =>
      fs.readFileString(path.join(root, ".cairn", name)).pipe(
        Effect.asSome,
        Effect.catchTag("PlatformError", () => Effect.succeedNone),
      );
    const text = (name: string) => read(name).pipe(Effect.map(Option.getOrElse(() => "")));
    const write = (name: string, content: string) =>
      fs.writeFileString(path.join(root, ".cairn", name), content);
    const snapshot = Effect.forEach(NAMES, read);
    const run = ({
      answers = [],
      drafts = DRAFTS,
      judge = Layer.empty,
      options: { dryRun = false, respec = false, spec: stopAfterSpec = false, yes = false } = {},
      spec = SPEC,
      split = () => [],
    }: Plan = {}) => {
      const services = Layer.mergeAll(
        scriptedTerminal(answers, (line) =>
          Seen.use((seen) => Ref.update(seen.shown, Array.append(line))),
        ).pipe(Layer.provideMerge(scriptedPlanner(spec, drafts, split))),
        MainCheckout.fixed(root),
        ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
        judge,
      );
      return Effect.gen(function* () {
        const before = yield* TestConsole.logLines;
        const result = yield* Effect.result(plan({ dryRun, respec, spec: stopAfterSpec, yes }));
        const seen = yield* Seen;
        const specs = yield* Ref.get(seen.specs);
        const tasks = yield* Ref.get(seen.tasks);
        const shown = yield* Ref.get(seen.shown);
        const after = yield* TestConsole.logLines;
        return {
          calls: { specs, tasks },
          lines: Array.filter(Array.drop(after, Array.length(before)), Predicate.isString),
          result,
          shown,
        };
      }).pipe(Effect.provide(services));
    };
    const needs = ({
      respec = false,
      spec = false,
    }: { readonly respec?: boolean; readonly spec?: boolean } = {}) =>
      needsPlanner({ respec, spec, yes: false }).pipe(Effect.provide(MainCheckout.fixed(root)));
    return { needs, read, run, snapshot, text, write };
  });

const inRepository = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

it.effect("answering no after the spec leaves spec.md written and no manifest", () =>
  inRepository(
    Effect.gen(function* () {
      const { read, run, text } = yield* setup({ "prd.md": PRD });
      const { calls, lines, result, shown } = yield* run({ answers: ["n"] });
      const spec = yield* text("spec.md");
      const prd = yield* text("prd.md");
      const manifest = yield* read("manifest.json");
      expect(Result.isSuccess(result)).toBe(true);
      expect(shown).toEqual([`${DRAFT_QUESTION} `]);
      expect(calls.tasks).toEqual([]);
      expect(Array.length(calls.specs)).toBe(1);
      expect(manifest).toEqual(Option.none());
      expect(spec).toContain("{#spec.capture}");
      expect(prd).toContain("{#prd.capture}");
      expect(lines).toEqual([
        "Added prd.notes",
        "Added prd.capture",
        JUDGING_SKIPPED,
        "spec.spec  .cairn/spec.md:1",
        "spec.capture  .cairn/spec.md:3  implements prd.capture",
        EDIT_SPEC,
      ]);
    }),
  ),
);

it.effect("a second run does not call Planner.spec and plans from the edited file", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text, write } = yield* setup({ "prd.md": PRD });
      yield* run({ answers: ["n"] });
      const written = yield* text("spec.md");
      const edited = `${written}Edited by a person.\n`;
      yield* write("spec.md", edited);
      const { calls, lines, result, shown } = yield* run({ answers: ["y"] });
      const manifestText = yield* text("manifest.json");
      const manifest = yield* decodeManifest(manifestText);
      expect(Result.isSuccess(result)).toBe(true);
      expect(calls.specs).toEqual([]);
      expect(Array.map(calls.tasks, ({ spec }) => spec)).toEqual([edited]);
      expect(shown).toEqual([`${WRITE_QUESTION} `]);
      expect(Array.map(manifest.tasks, (task) => [task.id, task.title, task.branch])).toEqual([
        ["t1", "Add capture", "notes/01-add-capture"],
      ]);
      expect(lines).toEqual([
        JUDGING_SKIPPED,
        "Stack 1",
        "  t1  pending  Add capture  sonnet/high  new",
        ".cairn/manifest.json task-without-statement t1 carries no done-when statement: none of prd.capture has one.",
        "Wrote .cairn/manifest.json",
        "Drew the stack diagram in .cairn/spec.md",
      ]);
      const after = yield* text("spec.md");
      expect(String.startsWith(edited)(after)).toBe(true);
      expect(after).toContain("cairn:stacks");
    }),
  ),
);

it.effect("--spec writes the spec and stops without asking", () =>
  inRepository(
    Effect.gen(function* () {
      const { read, run } = yield* setup({ "prd.md": PRD });
      const { calls, result, shown } = yield* run({ options: { spec: true } });
      const spec = yield* read("spec.md");
      const manifest = yield* read("manifest.json");
      expect(Result.isSuccess(result)).toBe(true);
      expect(shown).toEqual([]);
      expect(calls.tasks).toEqual([]);
      expect(Option.isSome(spec)).toBe(true);
      expect(manifest).toEqual(Option.none());
    }),
  ),
);

it.effect("--yes writes both without asking", () =>
  inRepository(
    Effect.gen(function* () {
      const { read, run } = yield* setup({ "prd.md": PRD });
      const { result, shown } = yield* run({ options: { yes: true } });
      const spec = yield* read("spec.md");
      const manifest = yield* read("manifest.json");
      expect(Result.isSuccess(result)).toBe(true);
      expect(shown).toEqual([]);
      expect(Option.isSome(spec)).toBe(true);
      expect(Option.isSome(manifest)).toBe(true);
    }),
  ),
);

it.effect('a plan that is written prints "The plan is up to date." and changes nothing', () =>
  inRepository(
    Effect.gen(function* () {
      const { run, snapshot } = yield* setup({ "prd.md": PRD });
      yield* run({ options: { yes: true } });
      const before = yield* snapshot;
      const { calls, lines, result, shown } = yield* run({ answers: ["y"] });
      const after = yield* snapshot;
      expect(Result.isSuccess(result)).toBe(true);
      expect(lines).toEqual([UP_TO_DATE]);
      expect(calls).toEqual({ specs: [], tasks: [] });
      expect(shown).toEqual([]);
      expect(after).toEqual(before);
    }),
  ),
);

it.effect("a lint error refuses the write and leaves the manifest as it was", () =>
  inRepository(
    Effect.gen(function* () {
      const { read, run } = yield* setup({ "prd.md": PRD });
      yield* run({ options: { yes: true } });
      const before = yield* read("manifest.json");
      const { lines, result, shown } = yield* run({
        drafts: [draft("Add capture", "spec.missing")],
        options: { respec: true, yes: true },
      });
      const after = yield* read("manifest.json");
      expect(result).toEqual(Result.fail(new ManifestRefused({ errors: 1 })));
      expect(Option.isSome(before)).toBe(true);
      expect(after).toEqual(before);
      expect(shown).toEqual([]);
      expect(Array.some(lines, String.includes("unknown-section"))).toBe(true);
    }),
  ),
);

it.effect("--respec is refused when a task has left pending, and changes nothing", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, snapshot, text, write } = yield* setup({ "prd.md": PRD });
      yield* run({ options: { yes: true } });
      const manifest = yield* text("manifest.json");
      yield* write(
        "manifest.json",
        String.replace('"status": "pending"', '"status": "running"')(manifest),
      );
      const before = yield* snapshot;
      const { calls, result } = yield* run({ options: { respec: true, yes: true } });
      const after = yield* snapshot;
      expect(result).toEqual(Result.fail(new RespecRefused({ tasks: ["t1"] })));
      expect(calls).toEqual({ specs: [], tasks: [] });
      expect(after).toEqual(before);
    }),
  ),
);

it.effect("--respec writes the spec and the manifest again when every task is pending", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup({ "prd.md": PRD });
      yield* run({ options: { yes: true } });
      const { calls, result } = yield* run({
        drafts: [draft("Add notes", "spec.capture")],
        options: { respec: true, yes: true },
      });
      const manifest = yield* text("manifest.json");
      expect(Result.isSuccess(result)).toBe(true);
      expect(Array.length(calls.specs)).toBe(1);
      expect(manifest).toContain("Add notes");
    }),
  ),
);

it.effect("prints judging as skipped once without a Judge, and says nothing with one", () =>
  inRepository(
    Effect.gen(function* () {
      const first = yield* setup({ "prd.md": PRD });
      const without = yield* first.run({ options: { yes: true } });
      const second = yield* setup({ "prd.md": PRD });
      const withJudge = yield* second.run({ judge: scriptedJudge(), options: { yes: true } });
      const judged = yield* second.text("judgments.json");
      expect(Array.filter(without.lines, (line) => line === JUDGING_SKIPPED)).toEqual([
        JUDGING_SKIPPED,
      ]);
      expect(Array.contains(withJudge.lines, JUDGING_SKIPPED)).toBe(false);
      expect(judged).toContain("jev-1.14.0");
    }),
  ),
);

it("the skip message names both ways to enable judging", () => {
  expect(JUDGING_SKIPPED).toContain("TYPESAFE_API_KEY");
  expect(JUDGING_SKIPPED).toContain("judge.gatewayTokenEnv");
});

it.effect.prop(
  "any answer but yes writes no manifest",
  [Schema.String.check(Schema.isPattern(/^[^yY\s]/u))],
  ([answer]) =>
    inRepository(
      Effect.gen(function* () {
        const { read, run } = yield* setup({ "prd.md": PRD });
        const { result } = yield* run({ answers: ["y", answer] });
        const spec = yield* read("spec.md");
        const manifest = yield* read("manifest.json");
        expect(Result.isSuccess(result)).toBe(true);
        expect(Option.isSome(spec)).toBe(true);
        expect(manifest).toEqual(Option.none());
      }),
    ),
  { arbitrary: { runs: 10 } },
);

it.effect("the model is needed only by a run that calls the planner", () =>
  inRepository(
    Effect.gen(function* () {
      const { needs, run, text, write } = yield* setup({ "prd.md": PRD });
      const fresh = yield* needs();
      yield* run({ options: { spec: true } });
      const specOnly = yield* needs({ spec: true });
      const tasksToDraft = yield* needs();
      yield* run({ options: { yes: true } });
      const upToDate = yield* needs();
      const respec = yield* needs({ respec: true });
      const manifest = yield* text("manifest.json");
      yield* write(
        "manifest.json",
        String.replace('"status": "pending"', '"status": "running"')(manifest),
      );
      const refused = yield* Effect.result(needs({ respec: true }));
      expect([fresh, specOnly, tasksToDraft, upToDate, respec]).toEqual([
        true,
        false,
        true,
        false,
        true,
      ]);
      expect(refused).toEqual(Result.fail(new RespecRefused({ tasks: ["t1"] })));
    }),
  ),
);

const decodeJudgments = Schema.decodeUnknownEffect(JudgmentsJson);

/** `judgments.json` as decoded, from a way to read a file of `.cairn/` as text. */
const judgmentsIn = (text: (name: string) => Effect.Effect<string, unknown>) =>
  text("judgments.json").pipe(Effect.flatMap(decodeJudgments));

const manifestIn = (text: (name: string) => Effect.Effect<string, unknown>) =>
  text("manifest.json").pipe(Effect.flatMap(decodeManifest));

/** Each judgment as `target question`, in a fixed order. */
const askedOf = (judgments: ReadonlyArray<Judgment>) =>
  Array.sort(
    Array.map(judgments, ({ question, target }) => `${targetName(target)} ${question}`),
    Order.String,
  );

/** Two drafts that keep every spec section and file of `whole`, the second after the first. */
const halves = (whole: TaskDraft): ReadonlyArray<TaskDraft> => [
  Struct.evolve(whole, { title: (title) => `${title} a` }),
  Struct.evolve(whole, {
    dependsOn: () => [`${whole.title} a`],
    title: (title) => `${title} b`,
  }),
];

const tooLarge = (title: string): Script => ({
  answer: (asked, question) =>
    asked === title && question === "size"
      ? Option.some({ confidence: 0.9, label: "too_large" })
      : Option.none(),
});

it.effect("with the key set, every section, task and the stack is judged and recorded", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup({ "prd.md": PRD });
      const { lines, result } = yield* run({
        judge: scriptedJudge(),
        options: { yes: true },
      });
      const recorded = yield* judgmentsIn(text);
      expect(Result.isSuccess(result)).toBe(true);
      expect(Array.contains(lines, JUDGING_SKIPPED)).toBe(false);
      expect(recorded.model).toBe("jev-1.14.0");
      expect(askedOf(recorded.judgments)).toEqual(
        Array.sort(
          [
            "spec.spec size",
            "spec.spec faithful",
            "spec.spec inScope",
            "spec.spec buildable",
            "spec.capture size",
            "spec.capture faithful",
            "spec.capture inScope",
            "spec.capture buildable",
            "t1 size",
            "t1 matches",
            "t1 inScope",
            "t1 category",
            "t1 model",
            "t1 reasoning",
            "stack complete",
            "stack ordered",
            "stack oneFeature",
          ],
          Order.String,
        ),
      );
      expect(Array.some(lines, String.includes("judge:"))).toBe(false);
    }),
  ),
);

it.effect(
  "a too_large draft is split before the stack is ordered, and the plan says so first",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* setup({ "prd.md": PRD });
        const { lines, result } = yield* run({
          judge: scriptedJudge(tooLarge("Add capture")),
          options: { yes: true },
          split: halves,
        });
        const manifest = yield* manifestIn(text);
        const recorded = yield* judgmentsIn(text);
        expect(Result.isSuccess(result)).toBe(true);
        expect(Array.map(manifest.tasks, (task) => [task.id, task.title])).toEqual([
          ["t1", "Add capture a"],
          ["t2", "Add capture b"],
        ]);
        const split = Array.filter(lines, String.startsWith("split"));
        expect(split).toEqual([
          'split  draft "Add capture": size is too_large, 0.9; split into 2 drafts: "Add capture a", "Add capture b"',
        ]);
        expect(Array.findFirstIndex(lines, String.startsWith("split"))).toEqual(
          Option.some(
            Option.getOrThrow(Array.findFirstIndex(lines, (line) => line === "Stack 1")) - 1,
          ),
        );
        // The split draft never got an ID; the drafts that replaced it did, and were judged again.
        expect(
          Array.map(
            Array.filter(recorded.judgments, (judgment) => judgment.question === "size"),
            ({ round, target }) => `${targetName(target)} ${round}`,
          ),
        ).toEqual(expect.arrayContaining(['draft "Add capture" 1', "t1 2", "t2 2"]));
        expect(Array.some(recorded.judgments, (judgment) => judgment.target.kind === "draft")).toBe(
          true,
        );
        expect(
          Array.some(
            recorded.judgments,
            (judgment) => judgment.target.kind === "task" && judgment.target.id === "t3",
          ),
        ).toBe(false);
      }),
    ),
);

it.effect("a confident model answer routes the task, and the plan names the task", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup({ "prd.md": PRD });
      const { lines } = yield* run({
        judge: scriptedJudge({
          answer: (_, question) =>
            question === "model" ? Option.some({ confidence: 0.9, label: "haiku" }) : Option.none(),
        }),
        options: { yes: true },
      });
      const manifest = yield* manifestIn(text);
      const recorded = yield* judgmentsIn(text);
      expect(Array.map(manifest.tasks, (task) => [task.id, task.model])).toEqual([["t1", "haiku"]]);
      expect(Array.filter(lines, String.startsWith("routed"))).toEqual([
        "routed  t1: model haiku, 0.9; routed sonnet to haiku",
      ]);
      expect(
        Array.map(
          Array.filter(recorded.judgments, (judgment) => judgment.action === "routed"),
          ({ question, target }) => [target, question],
        ),
      ).toEqual([[{ id: "t1", kind: "task" }, "model"]]);
    }),
  ),
);

it.effect(
  "a flag on the stack is printed after the stack, counted, and never blocks the write",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { read, run } = yield* setup({ "prd.md": PRD });
        const { lines, result } = yield* run({
          judge: scriptedJudge({
            probability: (title, question) =>
              title === "" && question === "complete" ? Option.some(0.1) : Option.none(),
          }),
          options: { yes: true },
        });
        const manifest = yield* read("manifest.json");
        expect(Result.isSuccess(result)).toBe(true);
        expect(Option.isSome(manifest)).toBe(true);
        const flagged = Array.findFirstIndex(lines, String.startsWith("stack judge:complete flag"));
        const stack = Array.findFirstIndex(lines, (line) => line === "Stack 1");
        expect(Option.isSome(flagged)).toBe(true);
        expect(Option.getOrThrow(flagged)).toBeGreaterThan(Option.getOrThrow(stack));
      }),
    ),
);

it.effect("a dry run counts the flags in its totals and writes nothing", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, snapshot } = yield* setup({ "prd.md": PRD });
      const before = yield* snapshot;
      const { lines, result } = yield* run({
        judge: scriptedJudge({
          probability: (title, question) =>
            title === "" && question === "complete" ? Option.some(0.1) : Option.none(),
        }),
        options: { dryRun: true },
      });
      const after = yield* snapshot;
      expect(Result.isSuccess(result)).toBe(true);
      expect(after).toEqual(before);
      expect(Array.some(lines, String.includes(" 1 flags in "))).toBe(true);
    }),
  ),
);

it.effect("a judge that fails leaves the planner's work as it was, says so, and plans on", () =>
  inRepository(
    Effect.gen(function* () {
      const { read, run } = yield* setup({ "prd.md": PRD });
      const { lines, result } = yield* run({
        judge: Layer.succeed(
          Judge,
          Judge.of({ judge: () => Effect.fail(new JudgeError({ reason: "the model is down" })) }),
        ),
        options: { yes: true },
      });
      const manifest = yield* read("manifest.json");
      const judgments = yield* read("judgments.json");
      expect(Result.isSuccess(result)).toBe(true);
      expect(Option.isSome(manifest)).toBe(true);
      expect(judgments).toEqual(Option.none());
      expect(Array.filter(lines, String.startsWith("Judging failed"))).toEqual(
        Array.replicate("Judging failed: the model is down", 3),
      );
    }),
  ),
);

it.effect("the judgments of the spec step survive the tasks step in judgments.json", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup({ "prd.md": PRD });
      yield* run({ judge: scriptedJudge(), options: { spec: true } });
      const first = yield* judgmentsIn(text);
      expect(Array.dedupe(Array.map(first.judgments, ({ target }) => target.kind))).toEqual([
        "section",
      ]);
      yield* run({ answers: ["y"], judge: scriptedJudge() });
      const second = yield* judgmentsIn(text);
      expect(
        Array.sort(
          Array.dedupe(Array.map(second.judgments, ({ target }) => target.kind)),
          Order.String,
        ),
      ).toEqual(["section", "stack", "task"]);
      // A section judged in the first run is kept once, not once per run.
      expect(askedOf(second.judgments)).toEqual(Array.dedupe(askedOf(second.judgments)));
    }),
  ),
);
