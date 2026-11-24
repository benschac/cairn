import { Manifest, TaskDraft } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, Effect, FileSystem, Layer, Path, Predicate, Record, Schema } from "effect";

import { Planner, PlannerError, TaskDrafts } from "../src/planner.ts";
import { Script, scripted, unreachable } from "./fixtures/scripted-language-model.ts";
import type { Reply } from "./fixtures/scripted-language-model.ts";

/**
 * Runs `program` against a planner whose model plays `replies`. The program can read the prompts
 * the model was given from `Script`.
 */
const planning = <A, E>(
  replies: ReadonlyArray<string | Reply>,
  program: Effect.Effect<A, E, Planner | Script>,
) =>
  program.pipe(
    Effect.provide(
      Planner.layer.pipe(
        Layer.provideMerge(
          scripted(
            Array.map(replies, (reply) =>
              Predicate.isString(reply) ? Effect.succeed(reply) : reply,
            ),
          ),
        ),
      ),
    ),
  );

const encodeReply = Schema.encodeSync(Schema.fromJsonString(TaskDrafts));
const prompts = Script.use((script) => script.prompts);

/** The fixture of a file next to this test, and the repository's own `.cairn` files. */
const read = Effect.fn("read")(function* (url: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* path.fromFileUrl(new URL(url, import.meta.url));
  return yield* fs.readFileString(file);
});

/**
 * The drafts behind a manifest: what the planner would have proposed for it. A draft keeps what
 * the model decides, and names the drafts it depends on by title in place of their IDs. Every task
 * of a manifest fits a draft, because titles are unique in a manifest.
 */
const draftsOf = (manifest: Manifest) => {
  const titles = Record.fromIterableWith(manifest.tasks, (task) => [task.id, task.title]);
  return Array.map(manifest.tasks, (task) =>
    TaskDraft.make({
      dependsOn: Array.getSomes(Array.map(task.dependsOn, (id) => Record.get(titles, id))),
      files: task.files,
      model: task.model,
      prdSections: task.prdSections,
      reasoning: task.reasoning,
      specSections: task.specSections,
      title: task.title,
    }),
  );
};

const isPlannerError = Schema.is(PlannerError);

const spec = (prd: string) => Planner.use((planner) => planner.spec(prd));
const tasks = (prd: string, specText: string) =>
  Planner.use((planner) => planner.tasks(prd, specText));

it.effect.prop(
  "spec returns the model's markdown, and the prompt it sent holds the PRD",
  [Schema.NonEmptyString, Schema.String],
  ([prd, markdown]) =>
    planning(
      [markdown],
      Effect.gen(function* () {
        const written = yield* spec(prd);
        const seen = yield* prompts;
        expect(written).toBe(markdown);
        const [first = ""] = seen;
        expect(seen).toHaveLength(1);
        expect(first).toContain(prd);
      }),
    ),
);

it.effect("spec returns this repository's spec as the model wrote it", () =>
  Effect.gen(function* () {
    const specText = yield* read("../../../.cairn/spec.md");
    const written = yield* planning([specText], spec("Cairn turns a PRD into a stack of branches"));
    expect(written).toBe(specText);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a model failure while writing the spec is a PlannerError", () =>
  planning(
    [unreachable],
    Effect.gen(function* () {
      const failure = yield* Effect.flip(spec("prd"));
      expect(isPlannerError(failure)).toBe(true);
      expect(failure.call).toBe("spec");
    }),
  ),
);

it.effect("tasks decodes the drafts behind this repository's manifest", () =>
  Effect.gen(function* () {
    const manifestJson = yield* read("../../../.cairn/manifest.json");
    const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(manifestJson);
    // The reply is built from the manifest as it is now, so it cannot go stale: every task the
    // repository plans has to fit a draft and come back through the model's reply unchanged.
    const expected = draftsOf(manifest);
    const drafts = yield* planning([encodeReply({ drafts: expected })], tasks("prd", "spec"));
    expect(Array.length(drafts)).toBe(Array.length(manifest.tasks));
    expect(drafts).toEqual(expected);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.prop(
  "tasks returns any drafts the model sent, in order, with one call",
  [Schema.Array(TaskDraft)],
  ([drafts]) =>
    planning(
      [encodeReply({ drafts })],
      Effect.gen(function* () {
        const planned = yield* tasks("prd", "spec");
        const seen = yield* prompts;
        expect(planned).toEqual(drafts);
        expect(seen).toHaveLength(1);
      }),
    ),
);

it.effect.prop(
  "tasks prompts with the PRD and the spec",
  [Schema.NonEmptyString, Schema.NonEmptyString],
  ([prd, specText]) =>
    planning(
      [encodeReply({ drafts: [] })],
      Effect.gen(function* () {
        yield* tasks(prd, specText);
        const [first = ""] = yield* prompts;
        expect(first).toContain(prd);
        expect(first).toContain(specText);
      }),
    ),
);

it.effect.prop(
  "a reply that does not decode is retried once, and the second prompt holds the first",
  [Schema.Array(TaskDraft), Schema.NonEmptyString],
  ([drafts, bad]) =>
    planning(
      [bad, encodeReply({ drafts }), "never asked for"],
      Effect.gen(function* () {
        const planned = yield* tasks("prd", "spec");
        const seen = yield* prompts;
        expect(planned).toEqual(drafts);
        expect(seen).toHaveLength(2);
        const [first = "", second = ""] = seen;
        expect(second).toContain(first);
      }),
    ),
);

it.effect("the retry prompt holds the decode error of the first reply", () =>
  planning(
    ['{"drafts":[{"title":"No other fields"}]}', encodeReply({ drafts: [] })],
    Effect.gen(function* () {
      yield* tasks("prd", "spec");
      const [first = "", second = ""] = yield* prompts;
      expect(first).not.toContain("dependsOn");
      expect(second).toContain("dependsOn");
    }),
  ),
);

it.effect.prop(
  "two replies that do not decode fail with a PlannerError after two calls, never three",
  [Schema.NonEmptyString, Schema.NonEmptyString],
  ([one, two]) =>
    planning(
      [one, two, encodeReply({ drafts: [] })],
      Effect.gen(function* () {
        const failure = yield* Effect.flip(tasks("prd", "spec"));
        const seen = yield* prompts;
        expect(isPlannerError(failure)).toBe(true);
        expect(failure.call).toBe("tasks");
        expect(failure.reason).toContain("Structured output validation failed");
        expect(seen).toHaveLength(2);
      }),
    ),
);

it.effect("a model failure while planning tasks is a PlannerError, with no second try", () =>
  planning(
    [unreachable, encodeReply({ drafts: [] })],
    Effect.gen(function* () {
      const failure = yield* Effect.flip(tasks("prd", "spec"));
      const seen = yield* prompts;
      expect(isPlannerError(failure)).toBe(true);
      expect(failure.call).toBe("tasks");
      expect(seen).toHaveLength(1);
    }),
  ),
);

it.effect("a failure on the retry is a PlannerError too", () =>
  planning(
    ["not json", unreachable],
    Effect.gen(function* () {
      const failure = yield* Effect.flip(tasks("prd", "spec"));
      const seen = yield* prompts;
      expect(isPlannerError(failure)).toBe(true);
      expect(seen).toHaveLength(2);
    }),
  ),
);
