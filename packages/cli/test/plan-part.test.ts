import { IndexProse, Manifest, PrdSectionId, SpecSectionId, TaskDraft } from "@cairn/contract";
import type { ManifestTask } from "@cairn/contract";
import { sectionsOf } from "@cairn/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  ConfigProvider,
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
} from "effect";
import type { LanguageModel } from "effect/ai";
import { TerminalCapabilities } from "effect/cli";
import { TestConsole } from "effect/testing";

import { lintPlan } from "../src/commands/lint.ts";
import {
  NOT_PLANNED_YET,
  PART_UP_TO_DATE,
  PartRefused,
  RESPEC_TAKES_NO_IDS,
  needsPlanner,
  plan,
} from "../src/commands/plan.ts";
import type { PlanOptions } from "../src/commands/plan.ts";
import { Judge } from "../src/judge.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { Planner, PlannerError } from "../src/planner.ts";
import type { IndexTarget, PromptError } from "../src/planner.ts";
import type { PartIds } from "../src/planner.ts";
import { totalsLine } from "../src/print-stack.ts";
import { Script, scripted } from "./fixtures/scripted-language-model.ts";
import type { Reply } from "./fixtures/scripted-language-model.ts";
import { scriptedTerminal } from "./fixtures/scripted-terminal.ts";
import { stubPlanner } from "./fixtures/stub-planner.ts";

/** A PRD of two features. Beta has a list item that asks for an ID, and every section has a statement. */
const PRD = `# Notes {#prd.notes}

## Alpha {#prd.alpha}

Keep a note.

Done when:

- A kept note shows in the list. {#prd.alpha#v1}

### Alpha detail {#prd.alpha.detail}

More alpha.

Done when:

- The detail shows. {#prd.alpha.detail#v1}

## Beta {#prd.beta}

Share a note.

- Link a note. {#}

Done when:

- A shared note opens by its link. {#prd.beta#v1}

### Beta detail {#prd.beta.detail}

More beta.

Done when:

- The detail shows. {#prd.beta.detail#v1}
`;

/** The same PRD without the item, so every part of it has a statement and the planner is not asked for drafts. */
const PRD_WITHOUT_ITEM = String.replace("- Link a note. {#}\n\n", "")(PRD);

/** What each feature's part holds, once the item has its ID. */
const BETA: Array.NonEmptyReadonlyArray<string> = [
  "prd.beta",
  "prd.beta.detail",
  "prd.beta.link-a",
];
const ALPHA: Array.NonEmptyReadonlyArray<string> = ["prd.alpha", "prd.alpha.detail"];
const KNOWN = Array.appendAll(ALPHA, Array.appendAll(BETA, ["prd.notes"]));

const BETA_SPEC = `### Beta feature {#spec.beta}

- Under: \`spec.notes-spec\`
- Implements: \`prd.beta\`, \`prd.beta.detail\`, \`prd.beta.link-a\`
- Files: \`src/beta.ts\`

Share a note.
`;

const ALPHA_SPEC = `### Alpha feature {#spec.alpha}

- Under: \`spec.notes-spec\`
- Implements: \`prd.alpha\`, \`prd.alpha.detail\`
- Files: \`src/alpha.ts\`

Keep a note.
`;

const LINK_SPEC = `### Link {#spec.link}

- Under: \`spec.notes-spec\`
- Implements: \`prd.beta.link-a\`
- Files: \`src/link.ts\`

Link a note.
`;

/** A section that implements both features, which a run for one of them must leave alone. */
const SHARED_SPEC = `### Shared {#spec.shared}

- Under: \`spec.notes-spec\`
- Implements: \`prd.alpha\`, \`prd.beta\`
- Files: \`src/shared.ts\`

Shared.
`;

const draft = (
  title: string,
  specSection: string,
  prdSections: Array.NonEmptyReadonlyArray<string>,
  dependsOn: Array<string>,
) =>
  Schema.decodeSync(TaskDraft)({
    category: "feature",
    dependsOn,
    files: [`src/${specSection}.ts`],
    model: "sonnet",
    prdSections,
    reasoning: "high",
    specSections: [specSection],
    title,
  });

const BETA_DRAFTS = [draft("Add beta", "spec.beta", BETA, [])];
const EXTRA_DRAFTS = [draft("Add extra", "spec.extra", ["prd.beta"], ["t1"])];
const LINK_DRAFTS = [draft("Add link", "spec.link", ["prd.beta.link-a"], [])];
const ALPHA_DRAFTS = [draft("Add alpha", "spec.alpha", ALPHA, ["t1"])];

const EMPTY_PROSE = { artifacts: [], decisions: [], requirements: [], summary: "", tests: [] };

/** The statements each feature's spec section proves, as a planner that follows the sections prompt writes them. */
const PROVED: Record.ReadonlyRecord<string, ReadonlyArray<string>> = {
  "spec.alpha": ["prd.alpha#v1", "prd.alpha.detail#v1"],
  "spec.beta": ["prd.beta#v1", "prd.beta.detail#v1"],
};

/** The prose of a section: one test that proves the statements of what it implements, or none. */
const proseOf = (section: IndexTarget) =>
  Schema.decodeUnknownEffect(IndexProse)({
    artifacts: EMPTY_PROSE.artifacts,
    decisions: EMPTY_PROSE.decisions,
    requirements: EMPTY_PROSE.requirements,
    summary: EMPTY_PROSE.summary,
    tests: Option.match(Record.get(PROVED, section.id), {
      onNone: () => [],
      onSome: (proves) => [
        { id: `${section.id}#t1`, kind: "scene", proves, text: "The feature shows." },
      ],
    }),
  }).pipe(Effect.orDie);

/** What the scripted planner was asked. A part is its IDs, sorted. */
interface Asked {
  readonly sections: ReadonlyArray<{
    readonly part: ReadonlyArray<string> | undefined;
    readonly prdSections: ReadonlyArray<string>;
    readonly rewrite: ReadonlyArray<string>;
  }>;
  readonly specs: number;
  readonly statements: ReadonlyArray<ReadonlyArray<string>>;
  readonly tasks: ReadonlyArray<{
    readonly existing: ReadonlyArray<string>;
    readonly part: ReadonlyArray<string> | undefined;
    readonly specSections: ReadonlyArray<string>;
  }>;
}

const NOTHING: Asked = { sections: [], specs: 0, statements: [], tasks: [] };

const sortedPart = (part: PartIds | undefined) =>
  Option.getOrUndefined(
    Option.map(Option.fromUndefinedOr(part), (ids) =>
      Array.sort(Array.fromIterable<string>(ids), Order.String),
    ),
  );

const mentions = (ids: ReadonlyArray<string>, id: string) => Array.contains(ids, id);

/**
 * A planner that answers a sections call with the spec of the feature it was asked for, a tasks call
 * with the drafts of the sections it was asked for, and drafts no statement. It notes what it is asked.
 */
const scriptedPlanner = (asked: Ref.Ref<Asked>, fixed: Option.Option<string>) =>
  Layer.succeed(
    Planner,
    stubPlanner({
      index: proseOf,
      sections: (_prd, _spec, prdSections, rewrite, part) =>
        Ref.update(asked, (seen) => ({
          ...seen,
          sections: Array.append(seen.sections, { part: sortedPart(part), prdSections, rewrite }),
        })).pipe(
          Effect.as(
            Option.getOrElse(fixed, () =>
              Array.join(
                Array.flatten([
                  mentions(prdSections, "prd.alpha") ? [ALPHA_SPEC] : [],
                  mentions(prdSections, "prd.beta") ? [BETA_SPEC] : [],
                  mentions(rewrite, "spec.beta") ? [BETA_SPEC] : [],
                  mentions(prdSections, "prd.beta.link-a") && !mentions(prdSections, "prd.beta")
                    ? [LINK_SPEC]
                    : [],
                ]),
                "\n",
              ),
            ),
          ),
        ),
      spec: () =>
        Ref.update(asked, (seen) => ({ ...seen, specs: seen.specs + 1 })).pipe(Effect.as("")),
      statements: (_prd, targets) =>
        Ref.update(asked, (seen) => ({
          ...seen,
          statements: Array.append(seen.statements, targets),
        })).pipe(Effect.as(Array.map(targets, (target) => ({ drafts: [], target })))),
      tasks: (_prd, _spec, specSections, existing, part) =>
        Ref.update(asked, (seen) => ({
          ...seen,
          tasks: Array.append(seen.tasks, {
            existing: Array.map(existing, (task) => task.id),
            part: sortedPart(part),
            specSections,
          }),
        })).pipe(
          Effect.as(
            mentions(specSections, "spec.alpha")
              ? ALPHA_DRAFTS
              : mentions(specSections, "spec.link")
                ? LINK_DRAFTS
                : mentions(specSections, "spec.extra")
                  ? EXTRA_DRAFTS
                  : BETA_DRAFTS,
          ),
        ),
    }),
  );

interface Run {
  readonly answers?: ReadonlyArray<string>;
  /** The judge of the run: none provides no `Judge`, as `cairn plan` does without a key. */
  readonly judge?: Layer.Layer<Judge> | typeof Layer.empty;
  readonly options?: Partial<PlanOptions>;
  readonly part?: ReadonlyArray<string>;
  /** What every sections call of the scripted planner answers, whatever it was asked. */
  readonly sections?: string;
  /** Replaces the scripted planner. The prompts its model was given are reported. */
  readonly planner?: Layer.Layer<Planner | Script | LanguageModel.LanguageModel, PromptError>;
  /** Whether stdin and stdout are a terminal. */
  readonly terminal?: boolean;
}

const optionsOf = (given: Partial<PlanOptions> = {}): PlanOptions => ({
  respec: false,
  spec: false,
  yes: true,
  ...given,
});

/** A repository whose `.cairn/` holds the given files, and a way to run `cairn plan` in it. */
const setup = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const cairn = path.join(root, ".cairn");
    yield* fs.makeDirectory(cairn);
    const write = (name: string, content: string) =>
      fs.writeFileString(path.join(cairn, name), content);
    yield* Effect.forEach(Record.toEntries(files), ([name, content]) => write(name, content), {
      discard: true,
    });
    const text = (name: string) =>
      fs
        .readFileString(path.join(cairn, name))
        .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
    /** Every file of `.cairn/` by name, to compare byte for byte. */
    const snapshot = Effect.gen(function* () {
      const names = yield* fs.readDirectory(cairn);
      const entries = yield* Effect.forEach(Array.sort(names, Order.String), (name) =>
        Effect.map(text(name), (content) => [name, content] as const),
      );
      return Record.fromEntries(entries);
    });
    const manifestOf = text("manifest.json").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))),
    );
    const run = ({
      answers = [],
      judge = Layer.empty,
      options = {},
      part = [],
      planner,
      sections,
      terminal = false,
    }: Run = {}) =>
      Effect.gen(function* () {
        const asked = yield* Ref.make(NOTHING);
        const shown = yield* Ref.make<ReadonlyArray<string>>([]);
        const before = yield* TestConsole.logLines;
        const services = Layer.mergeAll(
          scriptedTerminal(answers, (line) => Ref.update(shown, Array.append(line))),
          MainCheckout.fixed(root),
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
          judge,
          Option.getOrElse(Option.fromUndefinedOr(planner), () =>
            scriptedPlanner(asked, Option.fromUndefinedOr(sections)),
          ),
        );
        const { prompts, result } = yield* Effect.gen(function* () {
          const outcome = yield* Effect.result(plan(optionsOf({ part, ...options })));
          const script = yield* Effect.serviceOption(Script);
          return {
            prompts: yield* Option.match(script, {
              onNone: () => Effect.succeed(Array.empty<string>()),
              onSome: (found) => found.prompts,
            }),
            result: outcome,
          };
        }).pipe(
          Effect.provide(services),
          Effect.provideService(TerminalCapabilities.TerminalCapabilities, {
            canAnimate: terminal,
            canColor: false,
            canPrompt: terminal,
          }),
        );
        const after = yield* TestConsole.logLines;
        return {
          asked: yield* Ref.get(asked),
          lines: Array.filter(Array.drop(after, Array.length(before)), Predicate.isString),
          prompts,
          result,
          shown: yield* Ref.get(shown),
        };
      });
    const needs = (given: Partial<PlanOptions> = {}) =>
      needsPlanner(optionsOf(given)).pipe(Effect.provide(MainCheckout.fixed(root)));
    /** `cairn lint` in this repository: what it printed and whether it passed. */
    const lint = Effect.gen(function* () {
      const before = yield* TestConsole.logLines;
      const result = yield* Effect.result(lintPlan());
      const after = yield* TestConsole.logLines;
      return {
        lines: Array.filter(Array.drop(after, Array.length(before)), Predicate.isString),
        passed: Result.isSuccess(result),
      };
    }).pipe(Effect.provide(MainCheckout.fixed(root)));
    return { lint, manifestOf, needs, run, snapshot, text, write };
  });

const inRepository = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

/** The index of the first line at or after `from` that satisfies `test`. */
const indexFrom = (lines: ReadonlyArray<string>, from: number, test: (line: string) => boolean) =>
  Option.map(Array.findFirstIndex(Array.drop(lines, from), test), (found) => found + from);

/** The body of the spec section `spec.shared`, if `spec` has it. */
const bodyOf = (spec: string) =>
  Option.map(
    Array.findFirst(sectionsOf(spec), (section) => section.id === "spec.shared"),
    ({ body }) => body,
  );

const isPartLine = String.startsWith("part: ");

/** The failure of a run, which is what the tests below refuse with. */
const failureOf = <A, E>(result: Result.Result<A, E>) => Result.getFailure(result);

it.effect(
  "cairn plan prd.beta writes spec and tasks for prd.beta alone and leaves prd.alpha for lint",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { lint, manifestOf, run, text } = yield* setup({ "prd.md": PRD });
        const { asked, lines, result } = yield* run({ part: ["prd.beta"] });
        expect(Result.isSuccess(result)).toBe(true);
        // The spec is not written from nothing: the part's sections go under a heading of the run's own.
        expect(asked.specs).toBe(0);
        expect(asked.sections).toEqual([{ part: BETA, prdSections: BETA, rewrite: [] }]);
        const spec = yield* text("spec.md");
        expect(spec).toContain("# Notes spec {#spec.notes-spec}");
        const implemented = Array.flatMap(sectionsOf(spec), (section) => section.keys.implements);
        expect(Array.sort(Array.dedupe(implemented), Order.String)).toEqual(BETA);
        // The item asked for its ID, and the run gave it before it planned.
        const written = yield* text("prd.md");
        expect(written).toContain("- Link a note. {#prd.beta.link-a}");
        expect(lines).toContain("Added prd.beta.link-a");
        // Statements are drafted for what the part has none for, and not for prd.alpha.
        expect(asked.statements).toEqual([["prd.beta.link-a"]]);
        // The tasks name only the part's sections and the spec section the run wrote.
        const manifest = yield* manifestOf;
        expect(Array.flatMap(manifest.tasks, (task) => task.prdSections)).toEqual(BETA);
        expect(Array.flatMap(manifest.tasks, (task) => task.specSections)).toEqual(["spec.beta"]);
        expect(asked.tasks).toEqual([{ existing: [], part: BETA, specSections: ["spec.beta"] }]);
        expect(lines).toContain("Wrote .cairn/manifest.json");
        // Both reviews open with the part, and what lint finds outside it is listed after the stack.
        const first = indexFrom(lines, 0, isPartLine);
        const second = Option.flatMap(first, (at) => indexFrom(lines, at + 1, isPartLine));
        expect(Option.flatMap(first, (at) => Array.get(lines, at))).toEqual(
          Option.some("part: prd.beta (and 2 sections under it)"),
        );
        const before = (at: Option.Option<number>, test: (line: string) => boolean) =>
          Option.getOrElse(at, () => Infinity) <
          Option.getOrElse(indexFrom(lines, 0, test), () => -Infinity);
        expect(before(first, String.startsWith("spec.beta"))).toBe(true);
        expect(before(second, String.startsWith("Stack 1"))).toBe(true);
        const later = Array.findFirstIndex(lines, (line) => line === NOT_PLANNED_YET);
        expect(Option.flatMap(later, (at) => Array.get(lines, at + 1))).toEqual(
          Option.some(expect.stringContaining("unmapped-section")),
        );
        // cairn lint still reports prd.alpha, and nothing of beta's.
        const linted = yield* lint;
        expect(linted.passed).toBe(false);
        expect(
          Array.some(
            linted.lines,
            (line) =>
              String.includes("unmapped-section")(line) && String.includes("prd.alpha ")(line),
          ),
        ).toBe(true);
        // Beta's statements are in no test's `proves` here, so lint still warns
        // `unproved-statement` about them; what must be gone is beta's coverage.
        expect(
          Array.some(
            linted.lines,
            (line) => String.includes("prd.beta")(line) && String.includes("unmapped-")(line),
          ),
        ).toBe(false);
      }),
    ),
);

it.effect(
  "a later cairn plan prd.alpha adds tasks after the existing ones, which stay as they were",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { lint, manifestOf, run } = yield* setup({ "prd.md": PRD });
        yield* run({ part: ["prd.beta"] });
        const before = yield* manifestOf;
        const { asked, result } = yield* run({ part: ["prd.alpha"] });
        expect(Result.isSuccess(result)).toBe(true);
        const manifest = yield* manifestOf;
        expect(Array.take(manifest.tasks, Array.length(before.tasks))).toEqual(before.tasks);
        const added: ReadonlyArray<ManifestTask> = Array.drop(
          manifest.tasks,
          Array.length(before.tasks),
        );
        // The new task depends on the beta task, which a part run may do.
        expect(Array.map(added, (task) => [task.id, task.dependsOn, task.prdSections])).toEqual([
          ["t2", ["t1"], ALPHA],
        ]);
        // The planner reads the manifest that is there, and is asked only for alpha's sections.
        expect(asked.tasks).toEqual([
          { existing: ["t1"], part: ALPHA, specSections: ["spec.alpha"] },
        ]);
        expect(asked.sections).toEqual([{ part: ALPHA, prdSections: ALPHA, rewrite: [] }]);
        // Nothing is left for lint to report.
        expect((yield* lint).passed).toBe(true);
      }),
    ),
);

it.effect(
  "a part that is planned is up to date and needs no planner, while another part is not",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { needs, run, snapshot } = yield* setup({ "prd.md": PRD });
        yield* run({ part: ["prd.beta"] });
        const before = yield* snapshot;
        const needed = yield* needs({ part: ["prd.beta"] });
        const { asked, lines, result } = yield* run({ part: ["prd.beta"] });
        expect(Result.isSuccess(result)).toBe(true);
        expect(needed).toBe(false);
        expect(lines).toEqual([PART_UP_TO_DATE]);
        expect(asked).toEqual(NOTHING);
        const after = yield* snapshot;
        expect(after).toEqual(before);
        // The same plan is not up to date for the part nothing covers.
        const another = yield* needs({ part: ["prd.alpha"] });
        const whole = yield* needs();
        expect(another).toBe(true);
        expect(whole).toBe(true);
      }),
    ),
);

it.effect("a stale section outside the part is still reported", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text, write } = yield* setup({ "prd.md": PRD });
      yield* run({ part: ["prd.beta"] });
      const prd = yield* text("prd.md");
      yield* write("prd.md", String.replace("Share a note.", "Share a note with anyone.")(prd));
      const { lines } = yield* run({ part: ["prd.alpha"] });
      expect(
        Array.some(
          lines,
          (line) => String.includes("stale-section")(line) && String.includes("spec.beta")(line),
        ),
      ).toBe(true);
    }),
  ),
);

it.effect("a part run writes again the stale sections inside the part and no others", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text, write } = yield* setup({ "prd.md": PRD });
      yield* run({ options: { spec: true }, part: ["prd.alpha"] });
      yield* run({ options: { spec: true }, part: ["prd.beta"] });
      const prd = yield* text("prd.md");
      yield* write(
        "prd.md",
        String.replace(
          "Keep a note.",
          "Keep a note for good.",
        )(String.replace("Share a note.", "Share a note with anyone.")(prd)),
      );
      const { asked } = yield* run({ options: { spec: true }, part: ["prd.beta"] });
      expect(asked.sections).toEqual([{ part: BETA, prdSections: BETA, rewrite: ["spec.beta"] }]);
    }),
  ),
);

it.effect(
  "a draft statement under prd.alpha is not asked about, counted or changed in a prd.beta run",
  () =>
    inRepository(
      Effect.gen(function* () {
        const drafted = String.replace(
          "- A shared note opens by its link.",
          "- Draft: A shared note opens by its link.",
        )(
          String.replace(
            "- A kept note shows in the list.",
            "- Draft: A kept note shows in the list.",
          )(PRD),
        );
        const { run, text } = yield* setup({ "prd.md": drafted });
        const { lines, shown } = yield* run({
          answers: ["s"],
          options: { spec: true, yes: false },
          part: ["prd.beta"],
          terminal: true,
        });
        // One question, about beta's draft.
        expect(Array.filter(shown, String.includes("Is this what you meant?"))).toHaveLength(1);
        expect(Array.some(lines, String.includes("A shared note opens"))).toBe(true);
        expect(Array.some(lines, String.includes("A kept note shows"))).toBe(false);
        expect(lines).toContain("Warning: planned against 1 draft statement(s) in this part.");
        // The draft outside the part is as it was.
        const prd = yield* text("prd.md");
        expect(prd).toContain("- Draft: A kept note shows in the list. {#prd.alpha#v1}");
      }),
    ),
);

it.effect(
  "naming a list item alone plans that item, and leaves the section around it for later",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { manifestOf, run, text } = yield* setup({ "prd.md": PRD });
        const { asked, lines, result } = yield* run({ part: ["prd.beta.link-a"] });
        expect(Result.isSuccess(result)).toBe(true);
        expect(asked.sections).toEqual([
          { part: ["prd.beta.link-a"], prdSections: ["prd.beta.link-a"], rewrite: [] },
        ]);
        const spec = yield* text("spec.md");
        expect(spec).toContain("{#spec.link}");
        const manifest = yield* manifestOf;
        expect(Array.flatMap(manifest.tasks, (task) => task.prdSections)).toEqual([
          "prd.beta.link-a",
        ]);
        expect(lines).toContain("part: prd.beta.link-a");
        // What is under the section the item sits in is outside the part, so it is listed, not planned.
        const later = Array.findFirstIndex(lines, (line) => line === NOT_PLANNED_YET);
        expect(Option.isSome(later)).toBe(true);
        expect(
          Array.some(
            Array.drop(
              lines,
              Option.getOrElse(later, () => 0),
            ),
            (line) =>
              String.includes("unmapped-section")(line) &&
              String.includes("prd.beta.detail ")(line),
          ),
        ).toBe(true);
      }),
    ),
);

it.effect("an item given an ID after its section was planned is planned by naming it", () =>
  inRepository(
    Effect.gen(function* () {
      const { needs, run, text, write } = yield* setup({ "prd.md": PRD });
      yield* run({ part: ["prd.alpha"] });
      const prd = yield* text("prd.md");
      yield* write(
        "prd.md",
        String.replace(
          "Keep a note.\n\nDone when:",
          "Keep a note.\n\n- Pin a note. {#}\n\nDone when:",
        )(prd),
      );
      const needed = yield* needs({ part: ["prd.alpha.pin-a"] });
      const { asked, result } = yield* run({ part: ["prd.alpha.pin-a"] });
      expect(Result.isSuccess(result)).toBe(true);
      expect(needed).toBe(true);
      expect(asked.sections).toEqual([
        { part: ["prd.alpha.pin-a"], prdSections: ["prd.alpha.pin-a"], rewrite: [] },
      ]);
      // The new item is the one that gets a statement drafted.
      expect(asked.statements).toEqual([["prd.alpha.pin-a"]]);
    }),
  ),
);

it.effect(
  "a section that implements the part and something outside it is left alone and reported",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text, write } = yield* setup({ "prd.md": PRD });
        yield* run({ options: { spec: true }, part: ["prd.alpha"], sections: SHARED_SPEC });
        const before = yield* text("spec.md");
        const prd = yield* text("prd.md");
        yield* write("prd.md", String.replace("Share a note.", "Share a note with anyone.")(prd));
        const { asked, lines } = yield* run({ options: { spec: true }, part: ["prd.beta"] });
        // It is not written again, since that would write spec for the other part too.
        expect(Array.flatMap(asked.sections, (call) => call.rewrite)).toEqual([]);
        const after = yield* text("spec.md");
        expect(bodyOf(after)).toEqual(bodyOf(before));
        expect(Option.isSome(bodyOf(after))).toBe(true);
        expect(
          Array.some(
            lines,
            (line) =>
              String.includes("stale-section")(line) && String.includes("spec.shared")(line),
          ),
        ).toBe(true);
      }),
    ),
);

it.effect(
  "a spec section a person added for the part gets its task, though spec.json has no entry for it",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { manifestOf, run, text, write } = yield* setup({ "prd.md": PRD });
        yield* run({ part: ["prd.beta"] });
        const spec = yield* text("spec.md");
        yield* write(
          "spec.md",
          `${spec}\n## Extra {#spec.extra}\n\n- Implements: \`prd.beta\`\n- Files: \`src/extra.ts\`\n\nExtra.\n`,
        );
        const { asked, result } = yield* run({ part: ["prd.beta"] });
        expect(Result.isSuccess(result)).toBe(true);
        expect(asked.tasks).toEqual([
          { existing: ["t1"], part: BETA, specSections: ["spec.extra"] },
        ]);
        const manifest = yield* manifestOf;
        expect(Array.flatMap(manifest.tasks, (task) => task.specSections)).toEqual([
          "spec.beta",
          "spec.extra",
        ]);
      }),
    ),
);

/**
 * A judge that notes, for each call of the fourth checkpoint (the one that asks `built`), the PRD
 * sections asked `built`, the tasks asked `ordered` and the PRD sections the stack lists. It has
 * no judgment of its own.
 */
const recordingJudge = Effect.gen(function* () {
  const listed = yield* Ref.make<
    ReadonlyArray<{
      readonly built: ReadonlyArray<string>;
      readonly ordered: ReadonlyArray<string>;
      readonly stack: ReadonlyArray<string>;
    }>
  >([]);
  const judge = Layer.succeed(
    Judge,
    Judge.of({
      ask: () => Effect.succeed([]),
      judge: ({ prdSections, stack, tasks }, previous, { asks } = {}) =>
        // Only the fourth checkpoint asks `built` without `size`.
        Predicate.isNotUndefined(asks) && asks("built") && !asks("size")
          ? Ref.update(
              listed,
              Array.append({
                built: Array.map(prdSections, ({ id }) => id),
                ordered: Array.map(tasks, ({ id }) => id),
                stack: Array.map(stack.prdSections, ({ id }) => id),
              }),
            ).pipe(Effect.as(previous))
          : Effect.succeed(previous),
    }),
  );
  return { judge, listed };
});

it.effect(
  "the fourth checkpoint asks built of the PRD sections the part's new tasks implement and ordered of those tasks, and the stack lists only the part's PRD sections",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { judge, listed } = yield* recordingJudge;
        const { run } = yield* setup({ "prd.md": PRD });
        const { result } = yield* run({
          judge,
          part: ["prd.beta"],
        });
        expect(Result.isSuccess(result)).toBe(true);
        const seen = yield* Ref.get(listed);
        expect(seen).toEqual([
          {
            built: ["prd.beta", "prd.beta.detail"],
            ordered: ["t1"],
            stack: ["prd.beta", "prd.beta.detail"],
          },
        ]);
      }),
    ),
);

it.effect(
  "a later part's fourth checkpoint asks built only of what its own new tasks implement",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { judge, listed } = yield* recordingJudge;
        const { run } = yield* setup({ "prd.md": PRD });
        yield* run({ part: ["prd.beta"] });
        const { result } = yield* run({ judge, part: ["prd.alpha"] });
        expect(Result.isSuccess(result)).toBe(true);
        const seen = yield* Ref.get(listed);
        expect(Array.map(seen, ({ built, ordered }) => ({ built, ordered }))).toEqual([
          { built: ["prd.alpha", "prd.alpha.detail"], ordered: ["t2"] },
        ]);
      }),
    ),
);

it.effect("--dry-run with IDs plans in memory and its totals end with the part", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, snapshot } = yield* setup({ "prd.md": PRD });
      const before = yield* snapshot;
      const { lines, result } = yield* run({ options: { dryRun: true }, part: ["prd.beta"] });
      expect(Result.isSuccess(result)).toBe(true);
      expect(Array.last(lines)).toEqual(
        Option.some(
          expect.stringMatching(
            /^planned 1 sections, 1 tasks, \d+ lint errors, 0 flags in .* in part prd\.beta$/u,
          ),
        ),
      );
      const after = yield* snapshot;
      expect(after).toEqual(before);
    }),
  ),
);

it.prop(
  "the totals line names the part and only a part run's line does",
  [Schema.Array(PrdSectionId)],
  ([named]) => {
    const totals = {
      agent: "a",
      errors: 0,
      flags: 0,
      model: "m",
      sections: 1,
      seconds: 1,
      source: "cli",
      tasks: 1,
    };
    expect(String.includes(" in part ")(totalsLine(totals))).toBe(false);
    expect(
      String.endsWith(
        Array.isReadonlyArrayEmpty(named) ? "with cli a m" : `in part ${Array.join(named, ", ")}`,
      )(totalsLine({ ...totals, part: named })),
    ).toBe(true);
  },
);

const refusedWith = (result: Result.Result<unknown, unknown>) =>
  Option.getOrElse(
    Option.flatMap(failureOf(result), (failure) =>
      Schema.is(PartRefused)(failure) ? Option.some(failure.lines) : Option.none(),
    ),
    () => Array.empty<string>(),
  );

it.effect.prop(
  "IDs that name nothing are refused, one line each, before anything is written or asked",
  [Schema.Array(Schema.Union([PrdSectionId, SpecSectionId]))],
  ([generated]) =>
    inRepository(
      Effect.gen(function* () {
        const unknown = Array.filter(Array.dedupe(generated), (id) => !mentions(KNOWN, id));
        if (!Array.isReadonlyArrayNonEmpty(unknown)) {
          return;
        }
        const { run, snapshot } = yield* setup({ "prd.md": PRD });
        const before = yield* snapshot;
        // A known ID among them does not save the run.
        const { asked, result } = yield* run({ part: Array.prepend(unknown, "prd.beta") });
        expect(refusedWith(result)).toEqual(
          Array.map(unknown, (id) =>
            Schema.is(SpecSectionId)(id)
              ? `${id} is a spec section. cairn plan <id> takes PRD headings and list items.`
              : `Unknown PRD ID ${id}: no heading or list item in .cairn/prd.md has it.`,
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(asked).toEqual(NOTHING);
        const after = yield* snapshot;
        expect(after).toEqual(before);
      }),
    ),
  { arbitrary: { runs: 10 } },
);

it.effect(
  "an ID that is a statement, or a spec section, or missing, is refused with its own line",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { needs, run, snapshot } = yield* setup({ "prd.md": PRD });
        const before = yield* snapshot;
        const { result } = yield* run({ part: ["prd.beta#v1", "spec.x", "prd.nope"] });
        expect(refusedWith(result)).toEqual([
          "prd.beta#v1 is a done-when statement. Name its section, prd.beta.",
          "spec.x is a spec section. cairn plan <id> takes PRD headings and list items.",
          "Unknown PRD ID prd.nope: no heading or list item in .cairn/prd.md has it.",
        ]);
        const after = yield* snapshot;
        expect(after).toEqual(before);
        // The command finds out before it builds a model.
        const checked = yield* Effect.result(needs({ part: ["prd.nope"] }));
        expect(Result.isFailure(checked)).toBe(true);
      }),
    ),
);

it.effect("--respec with an ID is refused, and writes nothing", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, snapshot } = yield* setup({ "prd.md": PRD });
      const before = yield* snapshot;
      const { asked, result } = yield* run({ options: { respec: true }, part: ["prd.beta"] });
      expect(refusedWith(result)).toEqual([RESPEC_TAKES_NO_IDS]);
      expect(asked).toEqual(NOTHING);
      const after = yield* snapshot;
      expect(after).toEqual(before);
    }),
  ),
);

const OUTSIDE_SECTION = `### Beta feature {#spec.beta}

- Under: \`spec.notes-spec\`
- Implements: \`prd.beta\`, \`prd.beta.detail\`
- Context: \`prd.alpha\`
- Files: \`src/beta.ts\`

Share a note.
`;

it.effect(
  "a section with Context outside the part is sent back once, then fails with a PlannerError and writes nothing",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, snapshot } = yield* setup({ "prd.md": PRD_WITHOUT_ITEM });
        const before = yield* snapshot;
        const replies = Array.map([OUTSIDE_SECTION, OUTSIDE_SECTION], (reply): Reply =>
          Effect.succeed(reply),
        );
        const { prompts, result } = yield* run({
          part: ["prd.beta"],
          planner: Planner.layer.pipe(
            Layer.provide(NodeServices.layer),
            Layer.provideMerge(scripted(replies)),
          ),
        });
        const failure = failureOf(result);
        expect(Option.exists(failure, Schema.is(PlannerError))).toBe(true);
        expect(
          Option.map(Option.filter(failure, Schema.is(PlannerError)), ({ call }) => call),
        ).toEqual(Option.some("sections"));
        expect(
          Option.map(Option.filter(failure, Schema.is(PlannerError)), ({ reason }) => reason),
        ).toEqual(Option.some(expect.stringContaining("prd.alpha")));
        // The first reply was sent back with the error, the second failed it.
        expect(Array.length(prompts)).toBe(2);
        expect(Array.get(prompts, 1)).toEqual(
          Option.some(expect.stringContaining(Option.getOrElse(Array.get(prompts, 0), () => ""))),
        );
        const after = yield* snapshot;
        expect(after).toEqual(before);
      }),
    ),
);
