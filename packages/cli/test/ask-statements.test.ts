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
  Schema,
  Scope,
  String,
} from "effect";
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
import type { Judge } from "../src/judge.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { Planner } from "../src/planner.ts";
import { Recorder } from "./fixtures/recorder.ts";
import { scriptedTerminal } from "./fixtures/scripted-terminal.ts";
import { stubPlanner } from "./fixtures/stub-planner.ts";
import { scriptedJudge } from "./scripted-judge.ts";

const PRD = "# Notes\n\n## Capture\n\nKeep a note.\n";

const SPEC =
  "# Spec\n\n## Capture\n\n- Implements: `prd.capture`\n- Files: `src/capture.ts`\n\nKeep a note.\n";

const REWRITTEN =
  "## Capture {#spec.capture}\n\n- Implements: `prd.capture`\n- Files: `src/capture.ts`\n\nKeep a note.\n";

const decodeId = Schema.decodeSync(PrdSectionId);

/** What happened, in order: planner calls, and what was shown to the person. */
class Events extends Recorder<Events, string>()("@cairn/cli/test/Events") {}

/** A planner whose `statements` drafts `drafts` for the targets it names and nothing for the rest. */
const scriptedPlanner = (drafts: Readonly<Record<string, ReadonlyArray<string>>>) =>
  Layer.effect(
    Planner,
    Effect.gen(function* () {
      const note = (yield* Events).record;
      return stubPlanner({
        spec: () => note("spec").pipe(Effect.as(SPEC)),
        // A statement confirmed after the spec was written makes its section stale, so it is written again.
        sections: () => note("sections").pipe(Effect.as(REWRITTEN)),
        statements: (_, targets) =>
          note(`statements ${Array.join(targets, ",")}`).pipe(
            Effect.as(
              Array.map(targets, (target) => ({
                drafts: Option.getOrElse(Record.get(drafts, target), () => []),
                target,
              })),
            ),
          ),
      });
    }),
  );

interface Run {
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
        ).pipe(Layer.provideMerge(scriptedPlanner(drafts))),
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
