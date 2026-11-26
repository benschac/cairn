import { Manifest, TaskDraft } from "@cairn/contract";
import { STACKS_CLOSE, STACKS_OPEN, stackDiagramOf, withStackDiagram } from "@cairn/core";
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
  Result,
  Schema,
  Scope,
  String,
  Terminal,
} from "effect";
import { TestConsole } from "effect/testing";

import { ManifestRefused, UP_TO_DATE, plan, unusedJudge } from "../src/commands/plan.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { Planner } from "../src/planner.ts";
import { Script, scripted } from "./fixtures/scripted-language-model.ts";

const fenced = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\``;

const NodeId = Schema.Literals(["a", "b", "c", "d", "e"]);
const Direction = Schema.Literals(["TD", "LR", "BT", "RL"]);
const Edges = Schema.Array(Schema.Tuple([NodeId, NodeId])).check(Schema.isMinLength(1));

/** A flowchart that draws, or one that ends in half an edge. */
const diagram = (
  direction: string,
  edges: ReadonlyArray<readonly [string, string]>,
  broken: boolean,
) =>
  `flowchart ${direction}\n${Array.join(
    Array.appendAll(
      Array.map(edges, ([from, to]) => `  ${from} --> ${to}`),
      broken ? ["  a --"] : [],
    ),
    "\n",
  )}`;

const Blocks = Schema.Array(
  Schema.Struct({ broken: Schema.Boolean, direction: Direction, edges: Edges }),
).check(Schema.isMinLength(1), Schema.isMaxLength(5));

const HEAD = "# Spec {#spec.spec}\n\n## Store {#spec.store}\n\n- Implements: `prd.store`\n\n";

/**
 * A spec of one section and, after a line of prose, each block. A broken block is drawn broken
 * when `fixed` is false, and when it is true is fixed, or left out when `left` is true.
 */
const specOf = (blocks: typeof Blocks.Type, how: "as written" | "fixed" | "left out"): string =>
  `${HEAD}${Array.join(
    Array.map(blocks, ({ broken, direction, edges }) =>
      Array.join(
        Array.appendAll(
          ["Prose.", ""],
          broken && how === "left out"
            ? [""]
            : [fenced(diagram(direction, edges, broken && how === "as written")), ""],
        ),
        "\n",
      ),
    ),
    "\n",
  )}`;

const planning = <A, E>(
  replies: ReadonlyArray<string>,
  program: Effect.Effect<A, E, Planner | Script>,
) =>
  program.pipe(
    Effect.provide(
      Planner.layer.pipe(
        Layer.provide(NodeServices.layer),
        Layer.provideMerge(scripted(Array.map(replies, (reply) => Effect.succeed(reply)))),
      ),
    ),
  );

const warningsOf = (lines: ReadonlyArray<unknown>) =>
  Array.filter(
    lines,
    (line): line is string => Predicate.isString(line) && String.startsWith("Warning:")(line),
  );

it.effect.prop(
  "a spec whose diagrams all draw is returned as written, after one call",
  { blocks: Blocks },
  ({ blocks }) =>
    planning(
      [specOf(blocks, "fixed"), "never asked for"],
      Effect.gen(function* () {
        const written = yield* Planner.use((planner) => planner.spec("prd"));
        expect(written).toBe(specOf(blocks, "fixed"));
        const prompts = yield* Script.use((script) => script.prompts);
        expect(Array.length(prompts)).toBe(1);
      }),
    ),
);

it.effect.prop(
  "a diagram that does not draw is sent back once with its error, and the fixed reply is used",
  { blocks: Blocks },
  ({ blocks }) =>
    planning(
      [specOf(blocks, "as written"), specOf(blocks, "fixed"), "never asked for"],
      Effect.gen(function* () {
        const before = yield* TestConsole.logLines;
        const written = yield* Planner.use((planner) => planner.spec("prd"));
        const prompts = yield* Script.use((script) => script.prompts);
        const [first = "", second = ""] = prompts;
        const broken = Array.length(Array.filter(blocks, (block) => block.broken));
        expect(written).toBe(specOf(blocks, "fixed"));
        expect(Array.length(prompts)).toBe(broken === 0 ? 1 : 2);
        expect(String.includes("does not draw")(second)).toBe(broken > 0);
        expect(String.includes("spec.store")(second)).toBe(broken > 0);
        expect(String.includes(first)(second)).toBe(broken > 0);
        const printed = yield* TestConsole.logLines;
        expect(warningsOf(Array.drop(printed, Array.length(before)))).toEqual([]);
      }),
    ),
);

it.effect.prop(
  "a diagram that still does not draw is left out with a warning naming its section, never a third call",
  { blocks: Blocks },
  ({ blocks }) =>
    planning(
      [specOf(blocks, "as written"), specOf(blocks, "as written"), "never asked for"],
      Effect.gen(function* () {
        const before = yield* TestConsole.logLines;
        const written = yield* Planner.use((planner) => planner.spec("prd"));
        const prompts = yield* Script.use((script) => script.prompts);
        const broken = Array.length(Array.filter(blocks, (block) => block.broken));
        const printed = yield* TestConsole.logLines;
        const warnings = warningsOf(Array.drop(printed, Array.length(before)));
        expect(written).toBe(specOf(blocks, "left out"));
        expect(Array.length(prompts)).toBe(broken === 0 ? 1 : 2);
        expect(Array.length(warnings)).toBe(broken);
        expect(Array.every(warnings, String.includes("spec.store"))).toBe(true);
      }),
    ),
);

it.effect(
  "a section with no ID is named by its title, and one before any heading by the spec",
  () =>
    planning(
      [
        `${fenced("flowchart TD\n  a --")}\n\n## Billing\n\n${fenced("flowchart TD\n  a --")}\n`,
        `${fenced("flowchart TD\n  a --")}\n\n## Billing\n\n${fenced("flowchart TD\n  a --")}\n`,
      ],
      Effect.gen(function* () {
        const before = yield* TestConsole.logLines;
        const written = yield* Planner.use((planner) => planner.spec("prd"));
        const printed = yield* TestConsole.logLines;
        const warnings = warningsOf(Array.drop(printed, Array.length(before)));
        expect(written).toBe("\n## Billing\n\n");
        expect(
          Array.map(warnings, (line) => [
            String.includes("the spec")(line),
            String.includes('"Billing"')(line),
          ]),
        ).toEqual([
          [true, false],
          [false, true],
        ]);
      }),
    ),
);

const PRD = "# Notes\n\n## Capture\n\nKeep a note.\n";
const SPEC =
  "# Spec {#spec.spec}\n\n## Capture {#spec.capture}\n\n- Implements: `prd.capture`\n- Files: `src/capture.ts`\n\nKeep a note.\n";

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

/** A repository root whose `.cairn/` holds the files, and a way to run `cairn plan` in it with no questions to answer. */
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
    const text = (name: string) =>
      fs.readFileString(path.join(root, ".cairn", name)).pipe(
        Effect.asSome,
        Effect.catchTag("PlatformError", () => Effect.succeedNone),
        Effect.map(Option.getOrElse(() => "")),
      );
    const write = (name: string, content: string) =>
      fs.writeFileString(path.join(root, ".cairn", name), content);
    const run = (yes = true) =>
      Effect.gen(function* () {
        const before = yield* TestConsole.logLines;
        const result = yield* Effect.result(plan({ respec: false, spec: false, yes }));
        const after = yield* TestConsole.logLines;
        return {
          lines: Array.filter(Array.drop(after, Array.length(before)), Predicate.isString),
          result,
        };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              Planner,
              Planner.of({
                spec: () => Effect.succeed(SPEC),
                tasks: () => Effect.succeed(DRAFTS),
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
              }),
            ),
            Layer.succeed(
              Terminal.Terminal,
              Terminal.make({
                columns: Effect.succeed(80),
                display: () => Effect.void,
                readInput: Effect.never,
                readLine: Effect.succeed("n"),
                rows: Effect.succeed(24),
                size: Effect.never,
              }),
            ),
            MainCheckout.fixed(root),
            ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
            unusedJudge,
          ),
        ),
      );
    return { run, text, write };
  });

const inRepository = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

it.effect(
  "writing the manifest draws its stack diagram into spec.md, and nothing else changes",
  () =>
    inRepository(
      Effect.gen(function* () {
        const { run, text } = yield* setup({ "prd.md": PRD, "spec.md": SPEC });
        const { lines, result } = yield* run();
        const manifestText = yield* text("manifest.json");
        const manifest = yield* decodeManifest(manifestText);
        const spec = yield* text("spec.md");
        expect(Result.isSuccess(result)).toBe(true);
        expect(spec).toBe(withStackDiagram(SPEC, manifest));
        expect(String.includes(stackDiagramOf(manifest))(spec)).toBe(true);
        expect(String.startsWith(SPEC)(spec)).toBe(true);
        expect(Array.contains(lines, "Drew the stack diagram in .cairn/spec.md")).toBe(true);
      }),
    ),
);

it.effect("answering no to the manifest leaves spec.md as it was", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup({ "prd.md": PRD, "spec.md": SPEC });
      const { result } = yield* run(false);
      expect(Result.isSuccess(result)).toBe(true);
      const spec = yield* text("spec.md");
      const manifest = yield* text("manifest.json");
      expect(spec).toBe(SPEC);
      expect(manifest).toBe("");
    }),
  ),
);

it.effect("planning with a manifest on disk draws a diagram someone edited again, once", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text, write } = yield* setup({ "prd.md": PRD, "spec.md": SPEC });
      yield* run();
      const drawn = yield* text("spec.md");
      expect(String.includes(STACKS_OPEN)(drawn) && String.includes(STACKS_CLOSE)(drawn)).toBe(
        true,
      );
      yield* write("spec.md", String.replace("flowchart BT", "flowchart TB")(drawn));
      const again = yield* run();
      const redrawn = yield* text("spec.md");
      expect(redrawn).toBe(drawn);
      expect(again.lines).toEqual(["Drew the stack diagram in .cairn/spec.md"]);
      const settled = yield* run();
      expect(settled.lines).toEqual([UP_TO_DATE]);
    }),
  ),
);

it.effect("a Mermaid block that does not draw in the spec refuses the manifest", () =>
  inRepository(
    Effect.gen(function* () {
      const { run, text } = yield* setup({
        "prd.md": PRD,
        "spec.md": `${SPEC}\n${fenced("flowchart TD\n  a --")}\n`,
      });
      const { lines, result } = yield* run();
      expect(result).toEqual(Result.fail(new ManifestRefused({ errors: 1 })));
      expect(Array.some(lines, String.includes("bad-diagram"))).toBe(true);
      const manifest = yield* text("manifest.json");
      expect(manifest).toBe("");
    }),
  ),
);
