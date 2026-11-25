import { Manifest, SpecIndexJson, SpecSectionId, TaskId } from "@cairn/contract";
import { bodyHashOf } from "@cairn/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, Effect, FileSystem, Option, Ref, Result, Schema, String } from "effect";

import { Planner, PlannerError } from "../src/planner.ts";
import type { IndexProse, IndexTarget } from "../src/planner.ts";
import { specIndexOf, specIndexText } from "../src/spec-index.ts";
import type { SpecIndexInput } from "../src/spec-index.ts";

const decodeId = Schema.decodeSync(SpecSectionId);
const decodeTask = Schema.decodeSync(TaskId);

const unused = () => Effect.die("unused");

/** The prose a stub planner returns for a section: its summary names the section and the round. */
const proseFor = (id: string, round: number): IndexProse => ({
  artifacts: [],
  decisions: [],
  requirements: [],
  summary: `round ${round}: ${id}`,
  tests: [],
});

/** A planner that records the sections it is asked to index. */
const stubPlanner = (calls: Ref.Ref<ReadonlyArray<string>>, round: number) =>
  Planner.of({
    index: (target: IndexTarget) =>
      Ref.update(calls, Array.append(target.id)).pipe(Effect.as(proseFor(target.id, round))),
    sections: unused,
    spec: unused,
    splitSection: unused,
    statements: unused,
    splitTask: unused,
    tasks: unused,
  });

/** Indexes with a stub planner, and gives back the index and the sections it was asked about. */
const indexing = Effect.fn("indexing")(function* (input: SpecIndexInput, round = 1) {
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);
  const index = yield* specIndexOf(input).pipe(
    Effect.provideService(Planner, stubPlanner(calls, round)),
  );
  return { calls: yield* Ref.get(calls), index };
});

const manifestOf = Effect.fn("manifestOf")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(
    new URL("../../../.cairn/manifest.json", import.meta.url).pathname,
  );
  return yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(text);
});

/** A spec of one heading per level, in order, with the IDs `spec.s0`, `spec.s1` and so on. */
const specOf = (levels: ReadonlyArray<number>) =>
  Array.join(
    Array.map(
      levels,
      (level, at) => `${String.repeat(level)("#")} Section ${at} {#spec.s${at}}\n\nText ${at}.\n`,
    ),
    "\n",
  );

const PRD = "# Product {#prd.product}\n\nWhat it is.\n";

const inputOf = (
  manifest: Manifest,
  spec: string,
  rest: Partial<SpecIndexInput> = {},
): SpecIndexInput => ({
  changed: [],
  manifest,
  previous: Option.none(),
  prd: PRD,
  spec,
  written: [],
  ...rest,
});

const Levels = Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 }))).check(
  Schema.isMinLength(1),
);

/** The index of the nearest heading above `at` of a lower level, which is its parent. */
const parentAt = (levels: ReadonlyArray<number>, at: number): Option.Option<number> =>
  Array.findLastIndex(Array.take(levels, at), (above) => above < (levels[at] ?? 0));

it.effect.prop(
  "every section is indexed once, in document order, under the nearest heading above it",
  [Levels],
  ([levels]) =>
    Effect.gen(function* () {
      const manifest = yield* manifestOf();
      const { calls, index } = yield* indexing(inputOf(manifest, specOf(levels)));
      expect(calls).toHaveLength(levels.length);
      expect(Array.map(index.sections, (section) => section.id)).toEqual(
        Array.map(levels, (_level, at) => `spec.s${at}`),
      );
      Array.forEach(index.sections, (section, at) => {
        expect(section.level).toBe(levels[at]);
        expect(section.parent).toBe(
          Option.getOrNull(Option.map(parentAt(levels, at), (above) => `spec.s${above}`)),
        );
        expect(section.children).toEqual(
          Array.filterMap(levels, (_level, other) =>
            Option.exists(parentAt(levels, other), (above) => above === at)
              ? Result.succeed(`spec.s${other}`)
              : Result.failVoid,
          ),
        );
        expect(section.summary).toBe(`round 1: spec.s${at}`);
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.prop(
  "a section with an entry keeps it, and only a section named as changed is indexed again",
  [Levels, Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 }))],
  ([levels, pick]) =>
    Effect.gen(function* () {
      const manifest = yield* manifestOf();
      const spec = specOf(levels);
      const { index: first } = yield* indexing(inputOf(manifest, spec));
      const kept = yield* indexing(inputOf(manifest, spec, { previous: Option.some(first) }), 2);
      expect(kept.calls).toEqual([]);
      expect(kept.index).toEqual(first);
      const chosen = `spec.s${pick % levels.length}`;
      const again = yield* indexing(
        inputOf(manifest, spec, { changed: [decodeId(chosen)], previous: Option.some(first) }),
        2,
      );
      expect(again.calls).toEqual([chosen]);
      expect(Array.map(again.index.sections, (section) => section.summary)).toEqual(
        Array.map(levels, (_level, at) =>
          `spec.s${at}` === chosen ? `round 2: ${chosen}` : `round 1: spec.s${at}`,
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a section that left spec.md leaves the index, and a new one is indexed", () =>
  Effect.gen(function* () {
    const manifest = yield* manifestOf();
    const { index: first } = yield* indexing(inputOf(manifest, specOf([1, 2, 2])));
    const spec = "# One {#spec.s0}\n\n## Three {#spec.s3}\n\nNew.\n";
    const { calls, index } = yield* indexing(
      inputOf(manifest, spec, { previous: Option.some(first) }),
    );
    expect(calls).toEqual(["spec.s3"]);
    expect(Array.map(index.sections, (section) => section.id)).toEqual(["spec.s0", "spec.s3"]);
    expect(index.sections[0]?.children).toEqual(["spec.s3"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "the derived fields come from the section's own keys, the manifest and the human marker",
  () =>
    Effect.gen(function* () {
      const manifest = yield* manifestOf();
      const model = manifest.tasks[0];
      const [child, top] = [decodeId("spec.top.a"), decodeId("spec.top")];
      const tasked = {
        ...manifest,
        tasks: Array.make(
          { ...model, id: decodeTask("ta"), specSections: Array.make(child) },
          { ...model, id: decodeTask("tb"), specSections: Array.make(child, top) },
        ),
      };
      const spec = Array.join(
        [
          "# Top {#spec.top}",
          "",
          "- Implements: `prd.product`",
          "- Files: `packages/top.ts`",
          "",
          "## A {#spec.top.a}",
          "",
          "- Files: `packages/a.ts`",
          "- Depends on: `spec.top`",
          "- Defers: `prd.later`",
          "- Context: `prd.background`",
          "",
          "<!-- human -->",
          "",
        ],
        "\n",
      );
      const { index } = yield* indexing(inputOf(tasked, spec, { written: [top] }));
      const [topEntry, childEntry] = index.sections;
      expect(topEntry?.implements).toEqual(["prd.product"]);
      expect(topEntry?.files).toEqual(["packages/top.ts"]);
      expect(topEntry?.tasks).toEqual(["tb"]);
      expect(topEntry?.human).toBe(false);
      expect(topEntry?.writtenFrom.body).toBe(
        bodyHashOf("\n- Implements: `prd.product`\n- Files: `packages/top.ts`\n"),
      );
      expect(topEntry?.writtenFrom.prd).toEqual({ "prd.product": bodyHashOf("\nWhat it is.\n") });
      expect(childEntry?.implements).toEqual([]);
      expect(childEntry?.files).toEqual(["packages/a.ts"]);
      expect(childEntry?.dependsOn).toEqual(["spec.top"]);
      expect(childEntry?.defers).toEqual(["prd.later"]);
      expect(childEntry?.context).toEqual(["prd.background"]);
      expect(childEntry?.tasks).toEqual(["ta", "tb"]);
      expect(childEntry?.human).toBe(true);
      expect(childEntry?.writtenFrom.body).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "writtenFrom is kept when a person edits the body, and replaced when Cairn rewrites it",
  () =>
    Effect.gen(function* () {
      const manifest = yield* manifestOf();
      const id = decodeId("spec.s0");
      const { index: first } = yield* indexing(
        inputOf(manifest, "# One {#spec.s0}\n\nOld.\n", { written: [id] }),
      );
      const { index: edited } = yield* indexing(
        inputOf(manifest, "# One {#spec.s0}\n\nEdited.\n", {
          changed: [id],
          previous: Option.some(first),
        }),
      );
      const rewritten = yield* indexing(
        inputOf(manifest, "# One {#spec.s0}\n\nRewritten.\n", {
          previous: Option.some(first),
          written: [id],
        }),
        2,
      );
      expect(first.sections[0]?.writtenFrom.body).toBe(bodyHashOf("\nOld.\n"));
      expect(edited.sections[0]?.writtenFrom).toEqual(first.sections[0]?.writtenFrom);
      expect(rewritten.calls).toEqual(["spec.s0"]);
      expect(rewritten.index.sections[0]?.writtenFrom.body).toBe(bodyHashOf("\nRewritten.\n"));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a failed index call fails the whole index with its PlannerError", () =>
  Effect.gen(function* () {
    const manifest = yield* manifestOf();
    const broken = Planner.of({
      index: () => Effect.fail(new PlannerError({ call: "index", reason: "unreachable" })),
      sections: unused,
      spec: unused,
      splitSection: unused,
      statements: unused,
      splitTask: unused,
      tasks: unused,
    });
    const failure = yield* Effect.flip(
      specIndexOf(inputOf(manifest, specOf([1]))).pipe(Effect.provideService(Planner, broken)),
    );
    expect(failure.call).toBe("index");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.prop(
  "the file text decodes back to the same index and ends in one newline",
  [Levels],
  ([levels]) =>
    Effect.gen(function* () {
      const manifest = yield* manifestOf();
      const { index } = yield* indexing(inputOf(manifest, specOf(levels)));
      const text = yield* specIndexText(index);
      const decoded = yield* Schema.decodeEffect(SpecIndexJson)(text);
      expect(String.endsWith("}\n")(text)).toBe(true);
      expect(decoded).toEqual(index);
    }).pipe(Effect.provide(NodeServices.layer)),
);
