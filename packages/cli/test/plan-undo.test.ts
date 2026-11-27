import { Manifest, TaskDraft } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, ConfigProvider, Effect, FileSystem, Layer, Path, Predicate, Schema } from "effect";
import { TestConsole } from "effect/testing";

import { plan } from "../src/commands/plan.ts";
import { Git } from "../src/git.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { Planner } from "../src/planner.ts";
import { scriptedTerminal } from "./fixtures/scripted-terminal.ts";
import { stubPlanner } from "./fixtures/stub-planner.ts";

const PRD = "# Product {#prd.product}\n\n## Goal {#prd.goal}\n";

const SPEC = "# Spec {#spec.spec}\n\n## Store {#spec.store}\n\n- Implements: `prd.goal`\n";

const draft = (
  title: string,
  files: ReadonlyArray<string>,
  dependsOn: ReadonlyArray<string> = [],
) =>
  Schema.decodeUnknownSync(TaskDraft)({
    category: "feature",
    dependsOn,
    files,
    model: "sonnet",
    prdSections: ["prd.goal"],
    reasoning: "high",
    specSections: ["spec.store"],
    title,
  });

// t1 and t2 share two files and t3 and t4 one. t3 needs t2 and t4 needs t1, so t4 can stack on t3
// only once t2 is stacked on t1.
const DRAFTS = [
  draft("A", ["src/x1.ts", "src/x2.ts"]),
  draft("B", ["src/x1.ts", "src/x2.ts"]),
  draft("C", ["src/y.ts"], ["B"]),
  draft("D", ["src/y.ts"], ["A"]),
];

it.effect("undo takes out the orderings that only fitted on the chain the undone one made", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, ".cairn"));
    yield* fs.writeFileString(path.join(root, ".cairn", "prd.md"), PRD);
    yield* fs.writeFileString(path.join(root, ".cairn", "spec.md"), SPEC);
    yield* plan({ respec: false, spec: false, yes: false }).pipe(
      Effect.provide(
        Layer.mergeAll(
          MainCheckout.fixed(root),
          Git.memory(),
          scriptedTerminal(["undo 1", "y"]),
          Layer.succeed(Planner, stubPlanner({ tasks: () => Effect.succeed(DRAFTS) })),
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({})),
        ),
      ),
    );
    const logged = yield* TestConsole.logLines;
    const lines = Array.filter(logged, Predicate.isString);
    expect(lines).toContain("stacking t2 on t1 is undone, so t4 no longer stacks on t3 either.");
    const written = yield* fs.readFileString(path.join(root, ".cairn", "manifest.json"));
    const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(written);
    expect(
      Array.map(manifest.tasks, ({ id, orderedAfter, parent }) => ({
        id,
        orderedAfter: Array.map(orderedAfter, ({ task }) => task),
        parent,
      })),
    ).toEqual([
      { id: "t1", orderedAfter: [], parent: null },
      { id: "t2", orderedAfter: [], parent: null },
      { id: "t3", orderedAfter: [], parent: "t2" },
      { id: "t4", orderedAfter: [], parent: "t1" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
