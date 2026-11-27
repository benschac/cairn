import { TaskDraft } from "@cairn/contract";
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
import { TestConsole } from "effect/testing";

import { plan } from "../src/commands/plan.ts";
import { Git } from "../src/git.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { Planner } from "../src/planner.ts";
import { totalsLine } from "../src/print-stack.ts";
import { scriptedTerminal } from "./fixtures/scripted-terminal.ts";
import { stubPlanner } from "./fixtures/stub-planner.ts";

const PRD = "# Notes\n\n## Capture\n\nKeep a note.\n";

const SPEC =
  "# Spec\n\n## Capture\n\n- Implements: `prd.capture`\n- Files: `src/capture.ts`\n\nKeep a note.\n";

const DRAFTS = [
  Schema.decodeSync(TaskDraft)({
    category: "feature",
    dependsOn: [],
    files: ["src/capture.ts"],
    model: "sonnet",
    prdSections: ["prd.capture"],
    reasoning: "high",
    specSections: ["spec.capture"],
    title: "Add capture",
  }),
];

const NAMES = ["prd.md", "spec.md", "spec.json", "manifest.json", "config.json"] as const;

/** A planner that answers every call with the scripted spec and drafts, and counts its calls. */
const scriptedPlanner = (calls: Ref.Ref<number>) =>
  Layer.succeed(
    Planner,
    stubPlanner({
      spec: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(SPEC)),
      tasks: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(DRAFTS)),
    }),
  );

const inRepository = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

/** A repository whose `.cairn/` holds `files`, and a way to run `cairn plan --dry-run` in it. */
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
    // What a dry run must leave alone: every path under the root, a staging directory included, and the
    // bytes of each file in .cairn/.
    const snapshot = Effect.all({
      contents: Effect.forEach(NAMES, (name) =>
        fs.readFileString(path.join(root, ".cairn", name)).pipe(
          Effect.asSome,
          Effect.catchTag("PlatformError", () => Effect.succeedNone),
        ),
      ),
      listing: Effect.map(fs.readDirectory(root, { recursive: true }), (names) =>
        Array.sort(names, String.Order),
      ),
    });
    const run = (options: Partial<Parameters<typeof plan>[0]> = {}) =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const asked = yield* Ref.make<ReadonlyArray<string>>([]);
        const before = yield* TestConsole.logLines;
        const result = yield* Effect.result(
          plan({ respec: false, spec: false, yes: false, ...options, dryRun: true }).pipe(
            Effect.provide(
              Layer.mergeAll(
                scriptedTerminal([], (line) => Ref.update(asked, Array.append(line))),
                scriptedPlanner(calls),
                MainCheckout.fixed(root),
                Git.memory(),
                ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
              ),
            ),
          ),
        );
        const after = yield* TestConsole.logLines;
        return {
          asked: yield* Ref.get(asked),
          calls: yield* Ref.get(calls),
          lines: Array.filter(Array.drop(after, Array.length(before)), Predicate.isString),
          result,
        };
      });
    return { run, snapshot };
  });

it.effect(
  "a dry run leaves .cairn/'s listing and every file's bytes as they were and asks nothing",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, snapshot } = yield* setup({ "prd.md": PRD });
        const before = yield* snapshot;
        const { asked, calls, lines, result } = yield* run();
        const after = yield* snapshot;
        expect(Result.isSuccess(result)).toBe(true);
        expect(after).toEqual(before);
        expect(asked).toEqual([]);
        expect(calls).toBe(2);
        expect(lines).toContain("  t1  pending  Add capture  sonnet/high  new");
        expect(lines).not.toContain("Wrote .cairn/manifest.json");
      }),
    ),
);

it.effect("the totals line counts what the scripted plan holds", () =>
  inRepository(
    Effect.gen(function* () {
      const { run } = yield* setup({ "prd.md": PRD });
      const { lines } = yield* run();
      expect(Array.last(lines)).toEqual(
        Option.some(
          expect.stringMatching(
            /^planned 2 sections, 1 tasks, 0 lint errors, 0 flags in [\d.]+s with cli claude default$/u,
          ),
        ),
      );
    }),
  ),
);

it.effect("--provider and --model replace the config's planner for the run", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, snapshot } = yield* setup({
        "config.json": '{"planner":{"source":"cli","cli":"codex"}}',
        "prd.md": PRD,
      });
      const before = yield* snapshot;
      const { lines } = yield* run({
        planner: { model: "small-one", provider: "openai", source: "api" },
      });
      expect(Option.getOrUndefined(Array.last(lines))).toMatch(/ with api openai small-one$/u);
      const after = yield* snapshot;
      expect(after).toEqual(before);
    }),
  ),
);

it.effect("--source api without a model fails before any call", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, snapshot } = yield* setup({ "prd.md": PRD });
      const before = yield* snapshot;
      const { calls, result } = yield* run({
        planner: { model: undefined, provider: undefined, source: "api" },
      });
      expect(Result.isFailure(result) && Predicate.isTagged(result.failure, "PlannerRefused")).toBe(
        true,
      );
      expect(Result.isFailure(result) && result.failure.message).toContain(
        "planner.model is required when planner.source is api",
      );
      const after = yield* snapshot;
      expect(calls).toBe(0);
      expect(after).toEqual(before);
    }),
  ),
);

it.prop(
  "the totals line names every count, the seconds and the planner",
  {
    errors: Schema.Int,
    flags: Schema.Int,
    model: Schema.NonEmptyString,
    sections: Schema.Int,
    seconds: Schema.Int,
    tasks: Schema.Int,
  },
  ({ errors, flags, model, sections, seconds, tasks }) => {
    expect(
      totalsLine({ agent: "codex", errors, flags, model, sections, seconds, source: "cli", tasks }),
    ).toBe(
      `planned ${sections} sections, ${tasks} tasks, ${errors} lint errors, ${flags} flags in ${seconds}s with cli codex ${model}`,
    );
  },
);
