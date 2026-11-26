import { Manifest, TaskDraft } from "@cairn/contract";
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
import { MainCheckout } from "../src/main-checkout.ts";
import { Planner } from "../src/planner.ts";

const PRD = "# Notes\n\n## Capture\n\nKeep a note.\n";

const SPEC =
  "# Spec\n\n## Capture\n\n- Implements: `prd.capture`\n- Files: `src/capture.ts`\n\nKeep a note.\n";

const draft = (title: string, specSection: string) =>
  Schema.decodeSync(TaskDraft)({
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
const scriptedPlanner = (markdown: string, drafts: ReadonlyArray<TaskDraft>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const seen = Seen.of({
        shown: yield* Ref.make<ReadonlyArray<string>>([]),
        specs: yield* Ref.make<ReadonlyArray<string>>([]),
        tasks: yield* Ref.make<ReadonlyArray<{ readonly prd: string; readonly spec: string }>>([]),
      });
      const planner = Planner.of({
        spec: (prd) => Ref.update(seen.specs, Array.append(prd)).pipe(Effect.as(markdown)),
        tasks: (prd, spec) =>
          Ref.update(seen.tasks, Array.append({ prd, spec })).pipe(Effect.as(drafts)),
        splitSection: () => Effect.die("plan does not split a section"),
        statements: () => Effect.succeed([]),
        splitTask: () => Effect.die("plan does not split a task"),
        sections: () => Effect.die("plan does not write sections"),
        index: () =>
          Effect.succeed({
            artifacts: [],
            decisions: [],
            requirements: [],
            summary: "",
            tests: [],
          }),
      });
      return Context.make(Seen, seen).pipe(Context.add(Planner, planner));
    }),
  );

/** A terminal that answers each question with the next of `answers`, then ends its input. */
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

interface Plan {
  readonly answers?: ReadonlyArray<string>;
  readonly drafts?: ReadonlyArray<TaskDraft>;
  readonly env?: Readonly<Record<string, string>>;
  readonly options?: { readonly respec?: boolean; readonly spec?: boolean; readonly yes?: boolean };
  readonly spec?: string;
}

const NAMES = ["prd.md", "spec.md", "manifest.json"] as const;

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
      env = {},
      options: { respec = false, spec: stopAfterSpec = false, yes = false } = {},
      spec = SPEC,
    }: Plan = {}) => {
      const services = Layer.mergeAll(
        scriptedTerminal(answers).pipe(Layer.provideMerge(scriptedPlanner(spec, drafts))),
        MainCheckout.fixed(root),
        ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)),
      );
      return Effect.gen(function* () {
        const before = yield* TestConsole.logLines;
        const result = yield* Effect.result(plan({ respec, spec: stopAfterSpec, yes }));
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

it.effect("prints judging as skipped once, and says nothing when the key is set", () =>
  inRepository(
    Effect.gen(function* () {
      const first = yield* setup({ "prd.md": PRD });
      const without = yield* first.run({ options: { yes: true } });
      const second = yield* setup({ "prd.md": PRD });
      const withKey = yield* second.run({
        env: { TYPESAFE_API_KEY: "key" },
        options: { yes: true },
      });
      expect(Array.filter(without.lines, (line) => line === JUDGING_SKIPPED)).toEqual([
        JUDGING_SKIPPED,
      ]);
      expect(Array.contains(withKey.lines, JUDGING_SKIPPED)).toBe(false);
    }),
  ),
);

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
