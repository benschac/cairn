import { PrdSectionId } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Record,
  Ref,
  Result,
  Schema,
  Scope,
  String,
} from "effect";
import { DecisionModel } from "effect/ai";
import { TerminalCapabilities } from "effect/cli";
import { TestConsole } from "effect/testing";

import {
  DRAFT_QUESTION,
  REWRITE_QUESTION,
  draftWarning,
  targetsOf,
} from "../src/ask-statements.ts";
import { needsPlanner, plan } from "../src/commands/plan.ts";
import type { PlanOptions } from "../src/commands/plan.ts";
import { Judge } from "../src/judge.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { Planner } from "../src/planner.ts";
import { Recorder } from "./fixtures/recorder.ts";
import { scriptedTerminal } from "./fixtures/scripted-terminal.ts";
import { stubPlanner } from "./fixtures/stub-planner.ts";
import { defaults, scriptedJudge } from "./scripted-judge.ts";

const PRD = "# Notes\n\n## Capture\n\nKeep a note.\n";

const SPEC =
  "# Spec\n\n## Capture\n\n- Implements: `prd.capture`\n- Files: `src/capture.ts`\n\nKeep a note.\n";

const REWRITTEN =
  "## Capture {#spec.capture}\n\n- Implements: `prd.capture`\n- Files: `src/capture.ts`\n\nKeep a note.\n";

const decodeId = Schema.decodeSync(PrdSectionId);

/** What happened, in order: planner calls, and what was shown to the person. */
class Events extends Recorder<Events, string>()("@cairn/cli/test/Events") {}

/**
 * A planner whose `statements` drafts `drafts` for the targets it names and nothing for the rest.
 * Sent back drafts, it records them and answers each target with `again`'s drafts, or none.
 */
const scriptedPlanner = (
  drafts: Readonly<Record<string, ReadonlyArray<string>>>,
  again: Readonly<Record<string, ReadonlyArray<string>>>,
) =>
  Layer.effect(
    Planner,
    Effect.gen(function* () {
      const note = (yield* Events).record;
      return stubPlanner({
        spec: () => note("spec").pipe(Effect.as(SPEC)),
        // A statement confirmed after the spec was written makes its section stale, so it is written again.
        sections: () => note("sections").pipe(Effect.as(REWRITTEN)),
        statements: (_, targets, refused = []) =>
          note(
            Array.isReadonlyArrayNonEmpty(refused)
              ? `again ${Array.join(
                  Array.flatMap(refused, ({ drafts: sent, target }) =>
                    Array.map(sent, (draft) => `${target}: ${draft}`),
                  ),
                  "; ",
                )}`
              : `statements ${Array.join(targets, ",")}`,
          ).pipe(
            Effect.as(
              Array.map(targets, (target) => ({
                drafts: Option.getOrElse(
                  Record.get(Array.isReadonlyArrayNonEmpty(refused) ? again : drafts, target),
                  () => [],
                ),
                target,
              })),
            ),
          ),
      });
    }),
  );

interface Run {
  readonly again?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly answers?: ReadonlyArray<string>;
  readonly dryRun?: boolean;
  readonly drafts?: Readonly<Record<string, ReadonlyArray<string>>>;
  /** The judge of the run; none provides no `Judge`, as `cairn plan` does without a key. */
  readonly judge?: Layer.Layer<Judge> | typeof Layer.empty;
  /** Whether stdin and stdout are a terminal. */
  readonly terminal?: boolean;
  readonly yes?: boolean;
}

/** A repository root whose `.cairn/` holds `prd.md`, and a way to run `cairn plan --spec` in it. */
const setup = (prd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, ".cairn"));
    yield* fs.writeFileString(path.join(root, ".cairn", "prd.md"), prd);
    const text = (name: string) =>
      fs
        .readFileString(path.join(root, ".cairn", name))
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
    const run = ({
      again = {},
      answers = [],
      dryRun = false,
      drafts = {},
      judge = Layer.empty,
      terminal = true,
      yes = false,
    }: Run = {}) => {
      const options: PlanOptions = { dryRun, respec: false, spec: true, yes };
      const services = Layer.mergeAll(
        scriptedTerminal(answers, (line) =>
          Events.use((events) => events.record(`ask ${line}`)),
        ).pipe(Layer.provideMerge(scriptedPlanner(drafts, again))),
        MainCheckout.fixed(root),
        judge,
        ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
      );
      return Effect.gen(function* () {
        const before = yield* TestConsole.logLines;
        yield* plan(options);
        const after = yield* TestConsole.logLines;
        const events = yield* Events.use((log) => log.seen);
        return {
          events,
          lines: Array.filter(Array.drop(after, Array.length(before)), Predicate.isString),
        };
      }).pipe(
        Effect.provide(Layer.provideMerge(services, Events.layer)),
        Effect.provideService(TerminalCapabilities.TerminalCapabilities, {
          canAnimate: terminal,
          canColor: false,
          canPrompt: terminal,
        }),
      );
    };
    const needs = (options: PlanOptions) =>
      needsPlanner(options).pipe(Effect.provide(MainCheckout.fixed(root)));
    return { needs, run, text };
  });

const inRepository = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const TWO = {
  "prd.capture": ["Typing a note and pressing save lists it.", "Reloading keeps the note."],
};

const asked = (events: ReadonlyArray<string>) =>
  Array.filter(events, (event) => event === `ask ${DRAFT_QUESTION} `);

it.effect(
  "a section with no statement gets drafts, and they are asked about before the spec is written (prd.done-when.tracing#v1)",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* setup(PRD);
        const { events, lines } = yield* run({ answers: ["s", "s"], drafts: TWO });
        const prd = yield* text("prd.md");
        expect(events).toEqual([
          "statements prd.capture",
          `ask ${DRAFT_QUESTION} `,
          `ask ${DRAFT_QUESTION} `,
          "spec",
        ]);
        expect(prd).toBe(
          Array.join(
            [
              "# Notes {#prd.notes}",
              "",
              "## Capture {#prd.capture}",
              "",
              "Keep a note.",
              "",
              "Done when:",
              "",
              "- Draft: Typing a note and pressing save lists it. {#prd.capture#v1}",
              "- Draft: Reloading keeps the note. {#prd.capture#v2}",
              "",
            ],
            "\n",
          ),
        );
        // The section's title is printed once, with both drafts under it.
        expect(Array.filter(lines, (line) => line === "Capture")).toEqual(["Capture"]);
        expect(lines).toContain("  Typing a note and pressing save lists it.");
        expect(lines).toContain("  Reloading keeps the note.");
        expect(lines).toContain("Drafted prd.capture#v1");
      }),
    ),
);

it.effect(
  "accepting one draft and skipping another leaves the first confirmed and the second a draft, and the plan warns of one (prd.done-when.tracing#v2)",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* setup(PRD);
        const { lines } = yield* run({ answers: ["a", "s"], drafts: TWO });
        const prd = yield* text("prd.md");
        expect(prd).toContain("- Typing a note and pressing save lists it. {#prd.capture#v1}");
        expect(prd).toContain("- Draft: Reloading keeps the note. {#prd.capture#v2}");
        expect(Array.last(lines)).toEqual(Option.some(draftWarning(1)));
        expect(draftWarning(1)).toBe(
          "Warning: planned against 1 draft statement(s). Confirm them in .cairn/prd.md, or run cairn plan again to be asked.",
        );
      }),
    ),
);

it.effect(
  "--yes asks nothing and leaves every draft; a second run asks only about the drafts left",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* setup(PRD);
        const first = yield* run({ drafts: TWO, yes: true });
        expect(asked(first.events)).toEqual([]);
        expect(Array.last(first.lines)).toEqual(Option.some(draftWarning(2)));
        const second = yield* run({ answers: ["a", "s"] });
        // The spec exists, so nothing is drafted again, and both drafts are asked about.
        expect(asked(second.events)).toHaveLength(2);
        expect(second.events).not.toContain(`statements prd.capture`);
        const third = yield* run({ answers: ["a"] });
        expect(asked(third.events)).toHaveLength(1);
        expect(third.events).not.toContain(`statements prd.capture`);
        expect(third.lines).not.toContain(draftWarning(1));
        const prd = yield* text("prd.md");
        expect(prd).not.toContain("Draft:");
      }),
    ),
);

it.effect("an up-to-date plan with a draft left needs the planner only when it can ask", () =>
  inRepository(
    Effect.gen(function* () {
      const { needs, run } = yield* setup(PRD);
      yield* run({ drafts: TWO, yes: true });
      const asking = yield* needs({ respec: false, spec: true, yes: false });
      const answering = yield* needs({ respec: false, spec: true, yes: true });
      const dry = yield* needs({ dryRun: true, respec: false, spec: true, yes: false });
      expect([asking, answering, dry]).toEqual([true, false, false]);
      // Answering after that run can make a section need writing again, which needs the planner.
      yield* run({ answers: ["a", "a"] });
      const settled = yield* needs({ respec: false, spec: true, yes: false });
      expect(settled).toBe(false);
    }),
  ),
);

it.effect("a rewrite keeps the ID, confirms the statement and reads the next line", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup(PRD);
      const { events } = yield* run({
        answers: ["r", "A note is kept."],
        drafts: { "prd.capture": ["One."] },
      });
      expect(events).toContain(`ask ${REWRITE_QUESTION} `);
      const prd = yield* text("prd.md");
      expect(prd).toContain("- A note is kept. {#prd.capture#v1}");
    }),
  ),
);

it.effect(
  "delete removes the draft and the Done when line it leaves empty, and an empty rewrite is a skip",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* setup(PRD);
        yield* run({ answers: ["d", "r", ""], drafts: TWO });
        const prd = yield* text("prd.md");
        expect(prd).toContain("Done when:");
        expect(prd).not.toContain("Typing a note");
        expect(prd).toContain("- Draft: Reloading keeps the note. {#prd.capture#v2}");
      }),
    ),
);

it.effect(
  "a run with no terminal and a dry run ask nothing, and a dry run writes the drafts nowhere",
  () =>
    inRepository(
      Effect.gen(function* () {
        const piped = yield* setup(PRD);
        const quiet = yield* piped.run({ drafts: TWO, terminal: false });
        expect(asked(quiet.events)).toEqual([]);
        const kept = yield* piped.text("prd.md");
        expect(kept).toContain("- Draft: Reloading keeps the note.");
        expect(Array.last(quiet.lines)).toEqual(Option.some(draftWarning(2)));
        const dry = yield* setup(PRD);
        const ran = yield* dry.run({ drafts: TWO, dryRun: true });
        expect(asked(ran.events)).toEqual([]);
        expect(ran.events).toContain("statements prd.capture");
        const untouched = yield* dry.text("prd.md");
        expect(untouched).toBe(PRD);
      }),
    ),
);

it.effect("the end of input stops the questions and leaves the rest as drafts", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup(PRD);
      const { events } = yield* run({ answers: ["a"], drafts: TWO });
      expect(asked(events)).toHaveLength(2);
      const prd = yield* text("prd.md");
      expect(prd).toContain("- Typing a note and pressing save lists it. {#prd.capture#v1}");
      expect(prd).toContain("- Draft: Reloading keeps the note.");
    }),
  ),
);

it("targets are the sections but the title, and the items, that have an ID and no statement", () => {
  const prd = Array.join(
    [
      "# Notes {#prd.notes}",
      "",
      "## Capture {#prd.capture}",
      "",
      "- Keep a note. {#prd.capture.keep}",
      "- Share it. {#}",
      "- No ID.",
      "",
      "## Described {#prd.described}",
      "",
      "Done when:",
      "",
      "- It works. {#prd.described#v1}",
      "",
      "### Child {#prd.described.child}",
      "",
      "## Bare",
    ],
    "\n",
  );
  expect(targetsOf(prd, Option.none())).toEqual([
    "prd.capture",
    "prd.capture.keep",
    "prd.described.child",
  ]);
  expect(
    targetsOf(prd, Option.some(["prd.described.child", "prd.notes", "prd.described"])),
  ).toEqual(["prd.described.child"]);
  expect(decodeId("prd.capture")).toBe("prd.capture");
});

const WITH_LATER = "# Notes\n\n## Capture\n\nKeep a note.\n\n## Later\n\nOne day, maybe.\n";

/** A judge that answers `describesBuild` with `probability` for the section titled Later, and 0.9 for the rest. */
const laterAnswered = (probability: number) =>
  scriptedJudge({
    probability: (title, question) =>
      title === "Later" && question === "describesBuild" ? Option.some(probability) : Option.none(),
  });

const NO_DRAFT = "no draft  prd.later (describes nothing to build, 0.12)";

it.effect.each([
  { name: "asking", run: {} },
  { name: "--yes", run: { yes: true } },
  { name: "--dry-run", run: { dryRun: true } },
  { name: "a stdin that is not a terminal", run: { terminal: false } },
])(
  "a target answered no gets no draft and is listed, with $name (spec.planning.done-when.judging-drafts)",
  ({ run: variant }) =>
    inRepository(
      Effect.gen(function* () {
        const { run } = yield* setup(WITH_LATER);
        const { events, lines } = yield* run({ ...variant, judge: laterAnswered(0.12) });
        expect(events).toContain("statements prd.capture");
        expect(events).not.toContain("statements prd.capture,prd.later");
        expect(Array.contains(lines, NO_DRAFT)).toBe(true);
      }),
    ),
);

it.effect("a target answered unsure is drafted and not listed", () =>
  inRepository(
    Effect.gen(function* () {
      const { run } = yield* setup(WITH_LATER);
      const { events, lines } = yield* run({ judge: laterAnswered(0.5), yes: true });
      expect(events).toContain("statements prd.capture,prd.later");
      expect(Array.some(lines, String.startsWith("no draft"))).toBe(false);
    }),
  ),
);

it.effect("without a judge, the planner gets every target and nothing is listed", () =>
  inRepository(
    Effect.gen(function* () {
      const { run } = yield* setup(WITH_LATER);
      const { events, lines } = yield* run({ yes: true });
      expect(events).toContain("statements prd.capture,prd.later");
      expect(Array.some(lines, String.startsWith("no draft"))).toBe(false);
    }),
  ),
);

const NAMED = "Calling replanOf in packages/core returns an empty list.";
const REPLACED = "Planning again with nothing changed lists no work.";

/** A judge that answers each question with its probability in `answers`, and 0.5, which is unsure, for the rest. */
const answering = (answers: Readonly<Record<string, number>>) =>
  scriptedJudge({
    probability: (_, question) =>
      Option.some(Option.getOrElse(Record.get(answers, question), () => 0.5)),
  });

const Probability = Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 }));

const judgeLines = (lines: ReadonlyArray<string>) =>
  Array.filter(lines, String.startsWith("  judge:"));

it.effect.prop(
  "a new draft answered namesImplementation yes is drafted again once, and the replacement is not sent back (spec.planning.done-when.judging-drafts)",
  [Probability],
  ([probability]) =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* setup(PRD);
        // The judge says the same of the replacement, so a second pass would send it back again.
        const { events } = yield* run({
          again: { "prd.capture": [REPLACED] },
          drafts: { "prd.capture": [NAMED] },
          judge: answering({ namesImplementation: probability }),
          yes: true,
        });
        const prd = yield* text("prd.md");
        const sentBack = probability >= defaults.judge.pass;
        expect(Array.filter(events, String.startsWith("again"))).toEqual(
          sentBack ? [`again prd.capture: ${NAMED}`] : [],
        );
        expect(String.includes(`- Draft: ${REPLACED} {#prd.capture#v1}`)(prd)).toBe(sentBack);
        expect(String.includes(NAMED)(prd)).toBe(!sentBack);
        expect(
          Array.length(Array.filter(String.split("\n")(prd), String.startsWith("Done when:"))),
        ).toBe(1);
      }),
    ),
);

it.effect("a draft the planner does not write again is left as it was", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup(PRD);
      const { events } = yield* run({
        drafts: { "prd.capture": [NAMED, "Reloading keeps the note."] },
        judge: scriptedJudge({
          probability: (statement, question) =>
            question === "namesImplementation" && statement === NAMED
              ? Option.some(0.95)
              : Option.some(0.5),
        }),
        yes: true,
      });
      expect(Array.filter(events, String.startsWith("again"))).toEqual([
        `again prd.capture: ${NAMED}`,
      ]);
      const prd = yield* text("prd.md");
      expect(prd).toContain(`- Draft: ${NAMED} {#prd.capture#v1}`);
      expect(prd).toContain("- Draft: Reloading keeps the note. {#prd.capture#v2}");
    }),
  ),
);

it.effect(
  "a draft sent back is replaced in the part's one Done when list, beside the draft that was kept, and asked about as the replacement",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* setup(PRD);
        // The judge says the replacement names code too, and that only a person can settle it.
        const { events, lines } = yield* run({
          again: { "prd.capture": [REPLACED] },
          answers: ["s", "s"],
          drafts: { "prd.capture": [NAMED, "Reloading keeps the note."] },
          judge: scriptedJudge({
            probability: (statement, question) =>
              Option.some(
                statement === NAMED && question === "namesImplementation"
                  ? 0.95
                  : statement === REPLACED && question === "namesImplementation"
                    ? 0.95
                    : statement === REPLACED && question === "needsPerson"
                      ? 0.81
                      : 0.5,
              ),
          }),
        });
        const prd = yield* text("prd.md");
        expect(prd).toBe(
          Array.join(
            [
              "# Notes {#prd.notes}",
              "",
              "## Capture {#prd.capture}",
              "",
              "Keep a note.",
              "",
              "Done when:",
              "",
              "- Draft: Reloading keeps the note. {#prd.capture#v2}",
              `- Draft: ${REPLACED} {#prd.capture#v3}`,
              "",
            ],
            "\n",
          ),
        );
        expect(lines).not.toContain(`  ${NAMED}`);
        expect(lines).toContain(`  ${REPLACED}`);
        expect(Array.filter(events, String.startsWith("again"))).toHaveLength(1);
        // The replacement is judged for its notes, and the draft it replaced has none.
        expect(judgeLines(lines)).toEqual([REPLACEMENT_NOTE]);
        const at = Array.findFirstIndex(lines, (line) => line === `  ${REPLACED}`);
        expect(Option.map(at, (found) => Array.get(lines, found + 1))).toEqual(
          Option.some(Option.some(REPLACEMENT_NOTE)),
        );
      }),
    ),
);

const REPLACEMENT_NOTE =
  "  judge: names a file, function or test (0.95) · only a person can settle it (0.81), consider <!-- human -->";

const NOTE_YES =
  "  judge: says what the section asks (0.91) · a person could see it (0.88) · only a person can settle it (0.81), consider <!-- human -->";

it.effect("notes print under their draft, and prd.md holds no note text after the run", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup(PRD);
      const { lines } = yield* run({
        answers: ["a", "s"],
        drafts: TWO,
        judge: answering({ faithful: 0.91, needsPerson: 0.81, observable: 0.88 }),
      });
      const first = Array.findFirstIndex(
        lines,
        (line) => line === "  Typing a note and pressing save lists it.",
      );
      const second = Array.findFirstIndex(lines, (line) => line === "  Reloading keeps the note.");
      expect(Option.map(first, (at) => Array.get(lines, at + 1))).toEqual(
        Option.some(Option.some(NOTE_YES)),
      );
      expect(Option.map(second, (at) => Array.get(lines, at + 1))).toEqual(
        Option.some(Option.some(NOTE_YES)),
      );
      expect(Array.length(judgeLines(lines))).toBe(2);
      const prd = yield* text("prd.md");
      expect(prd).toContain("- Typing a note and pressing save lists it. {#prd.capture#v1}");
      expect(prd).toContain("- Draft: Reloading keeps the note. {#prd.capture#v2}");
      Array.forEach(["judge", "consider", "0.91", "<!-- human -->", "person could"], (text_) => {
        expect(prd).not.toContain(text_);
      });
    }),
  ),
);

it.effect("a no answer is a note too, and an unsure one is left out", () =>
  inRepository(
    Effect.gen(function* () {
      const { run } = yield* setup(PRD);
      const { lines } = yield* run({
        answers: ["s"],
        drafts: { "prd.capture": ["One."] },
        judge: answering({
          faithful: 0.12,
          namesImplementation: 0.05,
          needsPerson: 0.1,
          observable: 0.5,
        }),
      });
      expect(judgeLines(lines)).toEqual([
        "  judge: does not say what the section asks (0.12) · names no file, function or test (0.05) · a test could settle it (0.10)",
      ]);
    }),
  ),
);

it.effect("a draft whose answers are all unsure has no note", () =>
  inRepository(
    Effect.gen(function* () {
      const { run } = yield* setup(PRD);
      const { lines } = yield* run({
        answers: ["s"],
        drafts: { "prd.capture": ["One."] },
        judge: answering({}),
      });
      expect(judgeLines(lines)).toEqual([]);
    }),
  ),
);

it.effect(
  "a draft left from an earlier run gets notes and is never sent back, and its answers change nothing",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* setup(PRD);
        yield* run({ drafts: TWO, yes: true });
        const before = yield* text("prd.md");
        const { events, lines } = yield* run({
          again: { "prd.capture": [REPLACED] },
          answers: ["s", "s"],
          judge: answering({
            faithful: 0.91,
            namesImplementation: 0.95,
            needsPerson: 0.81,
            observable: 0.88,
          }),
        });
        expect(Array.length(judgeLines(lines))).toBe(2);
        expect(Array.filter(events, String.startsWith("again"))).toEqual([]);
        const after = yield* text("prd.md");
        expect(after).toBe(before);
      }),
    ),
);

it.effect.each([
  { name: "--yes", run: { yes: true } },
  { name: "--dry-run", run: { dryRun: true } },
  { name: "a stdin that is not a terminal", run: { terminal: false } },
])("$name prints no notes", ({ run: variant }) =>
  inRepository(
    Effect.gen(function* () {
      const { run } = yield* setup(PRD);
      const { lines } = yield* run({
        ...variant,
        drafts: TWO,
        judge: answering({ faithful: 0.91, needsPerson: 0.81, observable: 0.88 }),
      });
      expect(judgeLines(lines)).toEqual([]);
    }),
  ),
);

it.effect("without a judge, a draft that names code is asked about as it is, with no notes", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup(PRD);
      const { events, lines } = yield* run({
        again: { "prd.capture": [REPLACED] },
        answers: ["s"],
        drafts: { "prd.capture": [NAMED] },
      });
      expect(events).toEqual(["statements prd.capture", `ask ${DRAFT_QUESTION} `, "spec"]);
      expect(judgeLines(lines)).toEqual([]);
      const prd = yield* text("prd.md");
      expect(prd).toContain(`- Draft: ${NAMED} {#prd.capture#v1}`);
    }),
  ),
);

const WITH_ITEM =
  "# Notes\n\n## Capture\n\nKeep a note.\n\n- Share it. {#prd.capture.share}\n  - A note with no title shows an error. {#prd.capture.share.title}\n\nDeleting removes a note for good.\n";

it.effect(
  "the judge reads a section's whole own body but for its statements, whatever sits after a list item's",
  () =>
    inRepository(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const recording = Judge.layerWith(defaults).pipe(
          Layer.provide(
            Layer.effect(
              DecisionModel.DecisionModel,
              DecisionModel.make({
                decide: (options) =>
                  Ref.update(seen, Array.append(options.state)).pipe(
                    Effect.as({
                      answers: Record.map(options.decisions, (): DecisionModel.ProviderAnswer => ({
                        _tag: "Probability",
                        probability: 0.5,
                      })),
                      usage: { inputTokens: 1, outputTokens: 1 },
                    }),
                  ),
              }),
            ),
          ),
        );
        const { run } = yield* setup(WITH_ITEM);
        yield* run({
          answers: ["s", "s"],
          drafts: {
            "prd.capture": ["Keeping a note shows it."],
            "prd.capture.share": ["Sharing shows a link."],
          },
          judge: recording,
        });
        const states = yield* Ref.get(seen);
        const sections = Array.filterMap(states, (state) =>
          Predicate.hasProperty(state, "section") &&
          Predicate.hasProperty(state, "statement") &&
          Predicate.hasProperty(state.section, "body") &&
          Predicate.isString(state.section.body) &&
          state.statement === "Keeping a note shows it."
            ? Result.succeed(state.section.body)
            : Result.failVoid,
        );
        expect(sections).toHaveLength(1);
        const [body = ""] = sections;
        expect(body).toContain("Share it.");
        expect(body).toContain("Deleting removes a note for good.");
        expect(body).not.toContain("Done when:");
        expect(body).not.toContain("Draft:");
        expect(body).not.toContain("Sharing shows a link.");
        const itemBodies = Array.filterMap(states, (state) =>
          Predicate.hasProperty(state, "section") &&
          Predicate.hasProperty(state, "statement") &&
          Predicate.hasProperty(state.section, "body") &&
          Predicate.isString(state.section.body) &&
          state.statement === "Sharing shows a link."
            ? Result.succeed(state.section.body)
            : Result.failVoid,
        );
        // An item's own body holds the items nested under it.
        expect(itemBodies).toEqual(["Share it.\n- A note with no title shows an error."]);
      }),
    ),
);

it.effect("a list item's drafts stay in its one nested Done when list when one is sent back", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup(WITH_ITEM);
      yield* run({
        again: { "prd.capture.share": [REPLACED] },
        drafts: { "prd.capture.share": [NAMED, "Sharing shows a link."] },
        judge: scriptedJudge({
          probability: (statement, question) =>
            Option.some(question === "namesImplementation" && statement === NAMED ? 0.95 : 0.5),
        }),
        yes: true,
      });
      const prd = yield* text("prd.md");
      expect(
        Array.filter(String.split("\n")(prd), (line) => String.trim(line) === "Done when:"),
      ).toHaveLength(1);
      expect(prd).toContain(
        "  - Draft: Sharing shows a link. {#prd.capture.share#v2}\n  - Draft: " +
          REPLACED +
          " {#prd.capture.share#v3}",
      );
      expect(prd).not.toContain(NAMED);
    }),
  ),
);
