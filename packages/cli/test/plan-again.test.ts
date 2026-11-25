import { Manifest, SpecIndexJson, SpecSectionId, TaskDraft } from "@cairn/contract";
import type { IndexedSection, PrdSectionId, SpecIndex } from "@cairn/contract";
import { bodyHashOf, sectionsOf } from "@cairn/core";
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
  Path,
  Predicate,
  Record,
  Ref,
  Result,
  Schema,
  Scope,
  String,
  Terminal,
} from "effect";
import { TestConsole } from "effect/testing";

import {
  AcceptRefused,
  DRAFT_QUESTION,
  ManifestRefused,
  needsPlanner,
  plan,
  UP_TO_DATE,
  WRITE_QUESTION,
} from "../src/commands/plan.ts";
import type { PlanOptions } from "../src/commands/plan.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { Planner } from "../src/planner.ts";
import { editedOf } from "../src/spec-index.ts";
import { mergeSections } from "../src/spec-merge.ts";

const PRD = `# Notes {#prd.notes}

## Capture {#prd.capture}

Keep a note.
`;

const SHARE = "\n## Share {#prd.share}\n\nShare a note.\n";

/** What the first plan writes: a spec of one section that builds, and an acceptance section last. */
const SPEC = `# Spec {#spec.spec}

## Capture {#spec.capture}

- Implements: \`prd.capture\`
- Files: \`src/capture.ts\`

Keep a note.

## Acceptance {#spec.acceptance}

Done when a note is kept.
`;

const SHARING = `### Sharing {#spec.capture.sharing}

- Under: \`spec.capture\`
- Implements: \`prd.share\`
- Files: \`src/share.ts\`

Share a note.
`;

const draft = (title: string, specSection: string, prd: string, dependsOn: Array<string> = []) =>
  Schema.decodeSync(TaskDraft)({
    dependsOn,
    files: ["src/capture.ts"],
    model: "sonnet",
    prdSections: [prd],
    reasoning: "high",
    specSections: [specSection],
    title,
  });

const FIRST = [draft("Add capture", "spec.capture", "prd.capture")];
const SECOND = [draft("Add sharing", "spec.capture.sharing", "prd.share", ["t1"])];

const EMPTY_PROSE = { artifacts: [], decisions: [], requirements: [], summary: "", tests: [] };

/** What the scripted planner was asked. */
interface Asked {
  readonly indexed: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<{
    readonly prdSections: ReadonlyArray<string>;
    readonly rewrite: ReadonlyArray<string>;
  }>;
  readonly specs: number;
  readonly tasks: ReadonlyArray<{
    readonly existing: ReadonlyArray<string>;
    readonly specSections: ReadonlyArray<string>;
  }>;
}

class Seen extends Context.Service<
  Seen,
  {
    readonly asked: Ref.Ref<Asked>;
    readonly shown: Ref.Ref<ReadonlyArray<string>>;
  }
>()("@cairn/cli/test/plan-again/Seen") {}

/** What the scripted planner answers. */
interface Script {
  readonly drafts: ReadonlyArray<TaskDraft>;
  readonly sections: string;
  readonly spec: string;
}

const NOTHING: Asked = { indexed: [], sections: [], specs: 0, tasks: [] };

const scriptedPlanner = ({ drafts, sections, spec }: Script) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const seen = Seen.of({
        asked: yield* Ref.make(NOTHING),
        shown: yield* Ref.make<ReadonlyArray<string>>([]),
      });
      const planner = Planner.of({
        index: (target) =>
          Ref.update(seen.asked, (asked) => ({
            ...asked,
            indexed: Array.append(asked.indexed, target.id),
          })).pipe(Effect.as(EMPTY_PROSE)),
        sections: (_prd, _spec, prdSections, rewrite) =>
          Ref.update(seen.asked, (asked) => ({
            ...asked,
            sections: Array.append(asked.sections, { prdSections, rewrite }),
          })).pipe(Effect.as(sections)),
        spec: () =>
          Ref.update(seen.asked, (asked) => ({ ...asked, specs: asked.specs + 1 })).pipe(
            Effect.as(spec),
          ),
        splitSection: () => Effect.die("plan does not split a section"),
        statements: () => Effect.succeed([]),
        splitTask: () => Effect.die("plan does not split a task"),
        tasks: (_prd, _spec, specSections, existing) =>
          Ref.update(seen.asked, (asked) => ({
            ...asked,
            tasks: Array.append(asked.tasks, {
              existing: Array.map(existing, (task) => task.id),
              specSections,
            }),
          })).pipe(Effect.as(drafts)),
      });
      return Context.make(Seen, seen).pipe(Context.add(Planner, planner));
    }),
  );

const scriptedTerminal = (answers: ReadonlyArray<string>) =>
  Layer.effect(
    Terminal.Terminal,
    Effect.gen(function* () {
      const seen = yield* Seen;
      const remaining = yield* Ref.make(answers);
      return Terminal.make({
        columns: Effect.succeed(80),
        display: (text) => Ref.update(seen.shown, Array.append(text)),
        readInput: Effect.never,
        readLine: Ref.modify(remaining, (left) =>
          Array.match(left, {
            onEmpty: () => [Option.none<string>(), left] as const,
            onNonEmpty: ([first, ...rest]) => [Option.some(first), rest] as const,
          }),
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new Terminal.QuitError({})),
              onSome: Effect.succeed,
            }),
          ),
        ),
        rows: Effect.succeed(24),
        size: Effect.never,
      });
    }),
  );

interface Run {
  readonly answers?: ReadonlyArray<string>;
  readonly drafts?: ReadonlyArray<TaskDraft>;
  readonly options?: Partial<PlanOptions>;
  readonly sections?: string;
}

const decodeSpecId = Schema.decodeSync(SpecSectionId);

const optionsOf = (given: Partial<PlanOptions> = {}): PlanOptions => ({
  respec: false,
  spec: false,
  yes: false,
  ...given,
});

const NAMES = ["prd.md", "spec.md", "manifest.json", "spec.json"] as const;

/** A repository whose `.cairn/` holds the given files, and a way to run `cairn plan` in it. */
const setup = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, ".cairn"));
    const write = (name: string, content: string) =>
      fs.writeFileString(path.join(root, ".cairn", name), content);
    yield* Effect.forEach(Record.toEntries(files), ([name, content]) => write(name, content), {
      discard: true,
    });
    const read = (name: string) =>
      fs.readFileString(path.join(root, ".cairn", name)).pipe(
        Effect.asSome,
        Effect.catchTag("PlatformError", () => Effect.succeedNone),
      );
    const text = (name: string) => read(name).pipe(Effect.map(Option.getOrElse(() => "")));
    const remove = (name: string) => fs.remove(path.join(root, ".cairn", name));
    const snapshot = Effect.forEach(NAMES, read);
    const manifestOf = text("manifest.json").pipe(Effect.flatMap(decodeManifest));
    const indexOf = text("spec.json").pipe(Effect.flatMap(decodeIndex));
    const run = ({
      answers = [],
      drafts = FIRST,
      options: given = {},
      sections = SHARING,
    }: Run = {}) =>
      Effect.gen(function* () {
        const before = yield* TestConsole.logLines;
        const result = yield* Effect.result(plan(optionsOf(given)));
        const seen = yield* Seen;
        const asked = yield* Ref.get(seen.asked);
        const shown = yield* Ref.get(seen.shown);
        const after = yield* TestConsole.logLines;
        return {
          asked,
          lines: Array.filter(Array.drop(after, Array.length(before)), Predicate.isString),
          result,
          shown,
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            scriptedTerminal(answers).pipe(
              Layer.provideMerge(scriptedPlanner({ drafts, sections, spec: SPEC })),
            ),
            MainCheckout.fixed(root),
            ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
          ),
        ),
      );
    const needs = (given: Partial<PlanOptions> = {}) =>
      needsPlanner(optionsOf(given)).pipe(Effect.provide(MainCheckout.fixed(root)));
    return { indexOf, manifestOf, needs, read, remove, run, snapshot, text, write };
  });

const inRepository = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const decodeIndex = Schema.decodeUnknownEffect(SpecIndexJson);

/** A repository with the first plan written, and the PRD with a section added. */
const planned = Effect.gen(function* () {
  const repository = yield* setup({ "prd.md": PRD });
  yield* repository.run({ options: { yes: true } });
  yield* repository.write("prd.md", `${PRD}${SHARE}`);
  return repository;
});

it.effect(
  "planning again adds spec for the new PRD section and tasks for it, and changes no old task",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { indexOf, manifestOf, run, text } = yield* planned;
        const before = yield* manifestOf;
        const { asked, result } = yield* run({ drafts: SECOND, options: { yes: true } });
        const manifest = yield* manifestOf;
        const spec = yield* text("spec.md");
        const index = yield* indexOf;
        expect(Result.isSuccess(result)).toBe(true);
        // The spec is not written from nothing, and only what is new is asked for.
        expect(asked.specs).toBe(0);
        expect(asked.sections).toEqual([{ prdSections: ["prd.share"], rewrite: [] }]);
        expect(asked.tasks).toEqual([{ existing: ["t1"], specSections: ["spec.capture.sharing"] }]);
        // The new section sits under the one it named, after that section's own text, and the
        // acceptance section is still last.
        const ids = Array.getSomes(
          Array.map(sectionsOf(spec), (section) => Option.fromUndefinedOr(section.id)),
        );
        expect(Array.take(ids, 3)).toEqual(["spec.spec", "spec.capture", "spec.capture.sharing"]);
        expect(Array.last(ids)).toEqual(Option.some("spec.acceptance"));
        expect(spec).not.toContain("Under:");
        // Every task that was in the manifest is as it was, field for field, and the new one is after it.
        expect(Array.take(manifest.tasks, 1)).toEqual(before.tasks);
        expect(Array.map(manifest.tasks, (task) => [task.id, task.dependsOn, task.parent])).toEqual(
          [
            ["t1", [], null],
            ["t2", ["t1"], "t1"],
          ],
        );
        // spec.json knows the new section, what it was written from and the task that builds it.
        const entry = Array.findFirst(
          index.sections,
          (found) => found.id === "spec.capture.sharing",
        );
        expect(Option.map(entry, (found) => found.tasks)).toEqual(Option.some(["t2"]));
        expect(Option.map(entry, (found) => Record.keys(found.writtenFrom.prd))).toEqual(
          Option.some(["prd.share"]),
        );
        expect(Option.map(entry, (found) => found.writtenFrom.body)).toEqual(
          Option.some(
            bodyHashOf(
              Option.getOrElse(
                Option.map(
                  Array.findFirst(
                    sectionsOf(spec),
                    (section) => section.id === "spec.capture.sharing",
                  ),
                  (section) => section.body,
                ),
                () => "",
              ),
            ),
          ),
        );
      }),
    ),
);

it.effect("a run after planning again finds nothing to do and calls no planner", () =>
  inRepository(
    Effect.gen(function* () {
      const { needs, run, snapshot } = yield* planned;
      yield* run({ drafts: SECOND, options: { yes: true } });
      const before = yield* snapshot;
      const needed = yield* needs();
      const { asked, lines, result } = yield* run();
      expect(Result.isSuccess(result)).toBe(true);
      expect(needed).toBe(false);
      expect(lines).toEqual([UP_TO_DATE]);
      expect(asked).toEqual(NOTHING);
      const now = yield* snapshot;
      expect(now).toEqual(before);
    }),
  ),
);

it.effect("the planner is needed once the PRD has a section no spec covers", () =>
  inRepository(
    Effect.gen(function* () {
      const { needs } = yield* planned;
      const needed = yield* needs();
      expect(needed).toBe(true);
      // With --spec the tasks are not drafted, but the spec still is written.
      const needed2 = yield* needs({ spec: true });
      expect(needed2).toBe(true);
    }),
  ),
);

it.effect("--spec writes the new sections and stops without asking or drafting", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* planned;
      const before = yield* text("manifest.json");
      const { asked, shown } = yield* run({ options: { spec: true } });
      expect(shown).toEqual([]);
      expect(asked.tasks).toEqual([]);
      expect(asked.sections).toHaveLength(1);
      const specNow = yield* text("spec.md");
      expect(specNow).toContain("{#spec.capture.sharing}");
      const manifestNow = yield* text("manifest.json");
      expect(manifestNow).toBe(before);
    }),
  ),
);

it.effect(
  "answering no after the new sections leaves them written and the manifest as it was",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* planned;
        const before = yield* text("manifest.json");
        const { asked, shown } = yield* run({ answers: ["n"] });
        expect(shown).toEqual([`${DRAFT_QUESTION} `]);
        expect(asked.tasks).toEqual([]);
        const specNow2 = yield* text("spec.md");
        expect(specNow2).toContain("{#spec.capture.sharing}");
        const manifestNow2 = yield* text("manifest.json");
        expect(manifestNow2).toBe(before);
      }),
    ),
);

it.effect(
  "a spec section a person added that no task builds gets a task, and asks only before writing",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { manifestOf, run, text, write } = yield* setup({ "prd.md": PRD });
        yield* run({ options: { yes: true } });
        const spec = yield* text("spec.md");
        const added =
          "## Export {#spec.export}\n\n- Implements: `prd.capture`\n- Files: `src/export.ts`\n\nExport notes.\n\n## Acceptance";
        yield* write("spec.md", String.replace("## Acceptance", added)(spec));
        const { asked, shown } = yield* run({
          answers: ["y"],
          drafts: [draft("Add export", "spec.export", "prd.capture", ["t1"])],
        });
        expect(shown).toEqual([`${WRITE_QUESTION} `]);
        expect(asked.sections).toEqual([]);
        expect(asked.tasks).toEqual([{ existing: ["t1"], specSections: ["spec.export"] }]);
        const manifest = yield* manifestOf;
        expect(Array.map(manifest.tasks, (task) => task.id)).toEqual(["t1", "t2"]);
        // Only the section a person wrote is indexed; every other section keeps its entry.
        expect(asked.indexed).toEqual(["spec.export"]);
      }),
    ),
);

it.effect("a lint error refuses the write and leaves the manifest and the spec as they were", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, snapshot } = yield* planned;
      yield* run({ options: { spec: true } });
      const before = yield* snapshot;
      const { result } = yield* run({
        drafts: [draft("Add sharing", "spec.nowhere", "prd.share", ["t1"])],
        options: { yes: true },
      });
      expect(Result.isFailure(result) ? Schema.is(ManifestRefused)(result.failure) : false).toBe(
        true,
      );
      const now2 = yield* snapshot;
      expect(now2).toEqual(before);
    }),
  ),
);

/** Edits the PRD section a spec section was written from, so that section is out of date. */
const changed = Effect.gen(function* () {
  const repository = yield* setup({ "prd.md": PRD });
  yield* repository.run({ options: { yes: true } });
  yield* repository.write(
    "prd.md",
    String.replace("Keep a note.", "Keep a note and a title.")(PRD),
  );
  return repository;
});

it.effect(
  "a changed PRD section is reported, and its spec section is left alone when a task builds it",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, snapshot } = yield* changed;
        const before = yield* snapshot;
        const { asked, lines, result } = yield* run();
        expect(Result.isSuccess(result)).toBe(true);
        expect(asked).toEqual(NOTHING);
        expect(lines).toEqual([
          expect.stringContaining(
            ".cairn/spec.md:3 stale-section spec.capture implements prd.capture",
          ),
          ".cairn/manifest.json stale-task t1 builds spec.capture, which is stale.",
          UP_TO_DATE,
        ]);
        const now3 = yield* snapshot;
        expect(now3).toEqual(before);
      }),
    ),
);

it.effect("--accept records the current PRD hashes of a section and changes nothing else", () =>
  inRepository(
    Effect.gen(function* () {
      const { indexOf, run, snapshot, text, write } = yield* changed;
      // A person has edited the section too: accepting does not make the edit Cairn's.
      const spec = yield* text("spec.md");
      yield* write("spec.md", String.replace("Keep a note.", "Keep a note, my way.")(spec));
      const before = yield* indexOf;
      const files = yield* snapshot;
      const { lines, result } = yield* run({ options: { accept: "spec.capture" } });
      const after = yield* indexOf;
      const again = yield* run();
      expect(Result.isSuccess(result)).toBe(true);
      expect(lines).toEqual(["Accepted spec.capture"]);
      const { prd: oldPrd, body } = Option.getOrThrow(
        Array.findFirst(before.sections, (entry) => entry.id === "spec.capture"),
      ).writtenFrom;
      const accepted = Option.getOrThrow(
        Array.findFirst(after.sections, (entry) => entry.id === "spec.capture"),
      );
      expect(accepted.writtenFrom.body).toBe(body);
      expect(accepted.writtenFrom.body).not.toBe(
        bodyHashOf(
          Option.getOrElse(
            Option.map(
              Array.findFirst(sectionsOf(spec), (section) => section.id === "spec.capture"),
              (section) => String.replace("Keep a note.", "Keep a note, my way.")(section.body),
            ),
            () => "",
          ),
        ),
      );
      expect(accepted.writtenFrom.prd).not.toEqual(oldPrd);
      // Nothing else is different: not another file, not another entry, not another field.
      const filesNow = yield* snapshot;
      expect(Array.take(filesNow, 3)).toEqual(Array.take(files, 3));
      expect(after.sections).toEqual(
        Array.map(before.sections, (entry) =>
          entry.id === "spec.capture" ? { ...entry, writtenFrom: accepted.writtenFrom } : entry,
        ),
      );
      // The section is no longer out of date; the edit still shows in the task that builds it.
      expect(Array.some(again.lines, String.includes("stale-section"))).toBe(false);
      expect(Array.some(again.lines, String.includes("stale-task t1"))).toBe(true);
    }),
  ),
);

it.effect("--accept of a section the index lacks is refused and writes nothing", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, snapshot } = yield* changed;
      const before = yield* snapshot;
      const { result } = yield* run({ options: { accept: "spec.nowhere" } });
      expect(Result.isFailure(result) ? Schema.is(AcceptRefused)(result.failure) : false).toBe(
        true,
      );
      const now4 = yield* snapshot;
      expect(now4).toEqual(before);
    }),
  ),
);

/** A repository whose spec section was written by Cairn, nobody edited it and no task builds it. */
const unbuilt = Effect.gen(function* () {
  const repository = yield* setup({ "prd.md": PRD });
  yield* repository.run({ options: { spec: true } });
  yield* repository.write(
    "prd.md",
    String.replace("Keep a note.", "Keep a note and a title.")(PRD),
  );
  return repository;
});

const REWRITTEN = `### Capture again {#spec.capture}

- Implements: \`prd.capture\`
- Files: \`src/other.ts\`

Keep a note and a title.
`;

it.effect(
  "a section Cairn wrote, nobody edited and no task builds is written again in its place",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { indexOf, run, text } = yield* unbuilt;
        const before = yield* text("spec.md");
        const { asked, result } = yield* run({ options: { spec: true }, sections: REWRITTEN });
        const spec = yield* text("spec.md");
        const index = yield* indexOf;
        expect(Result.isSuccess(result)).toBe(true);
        expect(asked.sections).toEqual([
          { prdSections: ["prd.capture"], rewrite: ["spec.capture"] },
        ]);
        expect(spec).toContain("Keep a note and a title.");
        expect(spec).toContain("## Capture {#spec.capture}");
        expect(spec).not.toContain("Capture again");
        expect(spec).not.toContain("src/capture.ts");
        expect(Array.map(sectionsOf(spec), (section) => section.id)).toEqual(
          Array.map(sectionsOf(before), (section) => section.id),
        );
        const entry = Option.getOrThrow(
          Array.findFirst(index.sections, (found) => found.id === "spec.capture"),
        );
        expect(entry.files).toEqual(["src/other.ts"]);
        // The rewrite is what the index says Cairn wrote, so nobody has edited it.
        expect(editedOf(spec, index)).toEqual([]);
      }),
    ),
);

it.effect("a section a person edited is reported and not written again", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text, write } = yield* unbuilt;
      const spec = yield* text("spec.md");
      yield* write("spec.md", String.replace("Keep a note.", "Keep a note, my way.")(spec));
      const { asked, lines } = yield* run({ options: { spec: true } });
      expect(asked.sections).toEqual([]);
      expect(Array.some(lines, String.includes("stale-section spec.capture"))).toBe(true);
      const specNow3 = yield* text("spec.md");
      expect(specNow3).toContain("my way");
    }),
  ),
);

it.effect("a spec.json that is missing is built from the spec on disk, once", () =>
  inRepository(
    Effect.gen(function* () {
      const { needs, read, remove, run, text } = yield* setup({ "prd.md": PRD });
      yield* run({ options: { yes: true } });
      const spec = yield* text("spec.md");
      yield* remove("spec.json");
      const needed3 = yield* needs();
      expect(needed3).toBe(true);
      const { asked, lines, result } = yield* run();
      expect(Result.isSuccess(result)).toBe(true);
      expect(asked.indexed).toEqual(idsOf(spec));
      expect(lines).toEqual([UP_TO_DATE]);
      const index = yield* read("spec.json");
      expect(Option.isSome(index)).toBe(true);
      const needed4 = yield* needs();
      expect(needed4).toBe(false);
    }),
  ),
);

// A property over generated specs and replies: where a new section goes.
const Levels = Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 2 }))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8),
);
const Parents = Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 }))).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4),
);

/** A spec of one section per level, `spec.s0`, `spec.s1`…, under a title; the first is level 2. */
const specOf = (levels: ReadonlyArray<number>) =>
  `# Spec {#spec.spec}\n\n${Array.join(
    Array.map(
      levels,
      (level, at) =>
        `${String.repeat(at === 0 ? 2 : level)("#")} Section ${at} {#spec.s${at}}\n\nText ${at}.\n`,
    ),
    "\n",
  )}`;

const levelOf = (levels: ReadonlyArray<number>, at: number) =>
  at === 0 ? 2 : Option.getOrElse(Array.get(levels, at), () => 2);

/** New sections `spec.n0`…, each under the section `parents` picks, at a level that is wrong on purpose. */
const fragmentOf = (levels: ReadonlyArray<number>, parents: ReadonlyArray<number>) =>
  Array.join(
    Array.map(
      parents,
      (parent, at) =>
        `## New ${at} {#spec.n${at}}\n\n- Under: \`spec.s${parent % Array.length(levels)}\`\n- Implements: \`prd.x\`\n\nBody ${at}.\n`,
    ),
    "\n",
  );

const idsOf = (markdown: string) =>
  Array.getSomes(Array.map(sectionsOf(markdown), (section) => Option.fromUndefinedOr(section.id)));

it.effect.prop(
  "a new section goes under the section it names, one level deeper, after that section's last child",
  [Levels, Parents],
  ([levels, parents]) =>
    Effect.sync(() => {
      const spec = specOf(levels);
      const merged = mergeSections(spec, fragmentOf(levels, parents), []);
      const sections = sectionsOf(merged.markdown);
      const position = (id: string) =>
        Array.findFirstIndex(sections, (section) => section.id === id);
      expect(merged.markdown).not.toContain("Under:");
      // The old sections are all there, in their order.
      expect(Array.filter(idsOf(merged.markdown), String.startsWith("spec.s"))).toEqual(
        Array.filter(idsOf(spec), String.startsWith("spec.s")),
      );
      Array.forEach(parents, (parent, at) => {
        const parentAt = parent % Array.length(levels);
        const parentLevel = levelOf(levels, parentAt);
        const newAt = Option.getOrThrow(position(`spec.n${at}`));
        const found = Option.getOrThrow(Array.get(sections, newAt));
        expect(found.level).toBe(parentLevel + 1);
        // Everything below the parent in the old spec comes before the new section.
        const below = Array.takeWhile(
          Array.drop(Array.range(0, Array.length(levels) - 1), parentAt + 1),
          (other) => levelOf(levels, other) > parentLevel,
        );
        Array.forEach(below, (other) => {
          expect(Option.getOrThrow(position(`spec.s${other}`))).toBeLessThan(newAt);
        });
        // And it is still inside the parent: no heading between them is as shallow as the parent.
        const between = Array.take(
          Array.drop(sections, Option.getOrThrow(position(`spec.s${parentAt}`)) + 1),
          newAt - Option.getOrThrow(position(`spec.s${parentAt}`)) - 1,
        );
        expect(Array.every(between, (section) => section.level > parentLevel)).toBe(true);
      });
    }),
);

it.effect.prop(
  "a section written again keeps its heading, its place and every other section as it was",
  [Levels, Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 }))],
  ([levels, pick]) =>
    Effect.sync(() => {
      const spec = specOf(levels);
      const at = pick % Array.length(levels);
      const id = `spec.s${at}`;
      const merged = mergeSections(spec, `## Another title {#${id}}\n\nWritten again.\n`, [
        decodeSpecId(id),
      ]);
      const before = sectionsOf(spec);
      const after = sectionsOf(merged.markdown);
      expect(merged.rewritten).toEqual([id]);
      expect(Array.map(after, (section) => [section.id, section.title, section.level])).toEqual(
        Array.map(before, (section) => [section.id, section.title, section.level]),
      );
      Array.forEach(before, (section, index) => {
        const body = Option.getOrThrow(Array.get(after, index)).body;
        expect(String.trim(body)).toBe(
          section.id === id ? "Written again." : String.trim(section.body),
        );
      });
    }),
);

it.effect.prop(
  "a section written again with new sections nested in it keeps them under it, after its other children",
  [Levels, Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 }))],
  ([levels, pick]) =>
    Effect.sync(() => {
      const spec = specOf(levels);
      const at = pick % Array.length(levels);
      const id = `spec.s${at}`;
      const level = levelOf(levels, at);
      const merged = mergeSections(
        spec,
        `## Again {#${id}}\n\nBody.\n\n### Nested {#${id}.nested}\n\nNew.\n`,
        [decodeSpecId(id)],
      );
      const sections = sectionsOf(merged.markdown);
      const position = (found: string) =>
        Array.findFirstIndex(sections, (section) => section.id === found);
      const nested = Option.getOrThrow(position(`${id}.nested`));
      expect(Option.getOrThrow(Array.get(sections, nested)).level).toBe(level + 1);
      // Every old section below the rewritten one comes before the nested one.
      Array.forEach(
        Array.takeWhile(
          Array.drop(Array.range(0, Array.length(levels) - 1), at + 1),
          (other) => levelOf(levels, other) > level,
        ),
        (other) => {
          expect(Option.getOrThrow(position(`spec.s${other}`))).toBeLessThan(nested);
        },
      );
      expect(merged.rewritten).toEqual([id]);
      expect(Array.filter(idsOf(merged.markdown), (found) => found === id)).toHaveLength(1);
    }),
);

it.effect.prop(
  "an Under line in a fenced example is neither read nor removed",
  [Levels],
  ([levels]) =>
    Effect.sync(() => {
      const example = "```markdown\n- Under: `spec.s0`\n```";
      const merged = mergeSections(
        specOf(levels),
        `## Loose {#spec.loose}\n\nAn example:\n\n${example}\n`,
        [],
      );
      expect(merged.markdown).toContain(example);
      // Nothing placed it, so it is last, and not inside s0.
      expect(Array.last(idsOf(merged.markdown))).toEqual(Option.some("spec.loose"));
    }),
);

it.effect.prop(
  "a section the reply does not place goes above spec.acceptance, or last without one",
  [Levels, Schema.Boolean],
  ([levels, closes]) =>
    Effect.sync(() => {
      const spec = `${specOf(levels)}${closes ? "\n## Acceptance {#spec.acceptance}\n\nDone.\n" : ""}`;
      const merged = mergeSections(spec, "## Loose {#spec.loose}\n\nNowhere.\n", []);
      const ids = idsOf(merged.markdown);
      expect(Array.last(ids)).toEqual(Option.some(closes ? "spec.acceptance" : "spec.loose"));
      expect(Array.some(ids, (id) => id === "spec.loose")).toBe(true);
      expect(Array.length(ids)).toBe(Array.length(idsOf(spec)) + 1);
    }),
);

it.effect.prop(
  "a new section whose ID the spec has loses it, and a section that is not rewritable is not replaced",
  [Levels, Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 }))],
  ([levels, pick]) =>
    Effect.sync(() => {
      const spec = specOf(levels);
      const id = `spec.s${pick % Array.length(levels)}`;
      const merged = mergeSections(
        spec,
        `## Same ID {#${id}}\n\n- Under: \`spec.s0\`\n\nTwice.\n`,
        [],
      );
      expect(merged.rewritten).toEqual([]);
      expect(Array.filter(idsOf(merged.markdown), (found) => found === id)).toHaveLength(1);
      expect(merged.markdown).toContain("Same ID");
      expect(merged.markdown).toContain(`Text ${pick % Array.length(levels)}.`);
    }),
);

it.effect.prop(
  "editedOf names the sections of the index whose body no longer matches what was written",
  [Levels, Schema.Array(Schema.Boolean).check(Schema.isMaxLength(8))],
  ([levels, edits]) =>
    Effect.sync(() => {
      const spec = specOf(levels);
      const sections = sectionsOf(spec);
      const entry = (section: (typeof sections)[number], at: number): IndexedSection => ({
        artifacts: [],
        children: [],
        context: [],
        decisions: [],
        defers: [],
        dependsOn: [],
        files: [],
        human: false,
        id: decodeSpecId(Option.getOrElse(Option.fromUndefinedOr(section.id), () => "")),
        implements: [] as Array<PrdSectionId>,
        level: section.level,
        line: section.line,
        parent: null,
        requirements: [],
        summary: "",
        tasks: [],
        tests: [],
        title: section.title,
        // The title is the first section here, so the even ones, `spec.s1`, `spec.s3`…, were written by a
        // person: their body hash is null and an edit to one is not seen.
        writtenFrom: { body: at % 2 === 0 ? bodyHashOf(section.body) : null, prd: {} },
      });
      const index: SpecIndex = {
        manifest: ".cairn/manifest.json",
        prd: ".cairn/prd.md",
        sections: Array.map(sections, entry),
        source: ".cairn/spec.md",
        tasks: [],
        version: 1,
      };
      const edited = Array.map(levels, (_level, at) => edits[at] === true);
      const now = Array.reduce(Array.range(0, Array.length(levels) - 1), spec, (text, at) =>
        edited[at] === true ? String.replace(`Text ${at}.`, `Text ${at}, edited.`)(text) : text,
      );
      expect(editedOf(now, index)).toEqual(
        Array.filterMap(Array.range(0, Array.length(levels) - 1), (at) =>
          edited[at] === true && at % 2 === 1 ? Result.succeed(`spec.s${at}`) : Result.failVoid,
        ),
      );
      expect(editedOf(spec, index)).toEqual([]);
    }),
);
