import { PrdSectionId, SpecSectionId, TaskDraft } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, Effect, HashSet, Layer, Schema, String } from "effect";

import { Planner, PlannerError, TaskDrafts, outsidePartIn } from "../src/planner.ts";
import { Script, scripted } from "./fixtures/scripted-language-model.ts";
import type { Reply } from "./fixtures/scripted-language-model.ts";

const planning = <A, E>(
  replies: ReadonlyArray<string>,
  program: Effect.Effect<A, E, Planner | Script>,
) =>
  program.pipe(
    Effect.provide(
      Planner.layer.pipe(
        Layer.provide(NodeServices.layer),
        Layer.provideMerge(scripted(Array.map(replies, (reply): Reply => Effect.succeed(reply)))),
      ),
    ),
  );

const prompts = Script.use((script) => script.prompts);
const isPlannerError = Schema.is(PlannerError);

/** The IDs a part run is held to: one inside the part and one outside it. */
const INSIDE = Schema.decodeSync(PrdSectionId)("prd.inside");
const OUTSIDE = Schema.decodeSync(PrdSectionId)("prd.outside");

/** The part: the generated IDs without the outside one, and one that is always there. */
const partOf = (generated: ReadonlyArray<PrdSectionId>) =>
  HashSet.fromIterable(
    Array.prepend(
      Array.filter(generated, (id) => id !== OUTSIDE),
      INSIDE,
    ),
  );

const KEYS = ["Implements", "Defers", "Context"] as const;

/** A spec section whose `key` names `ids`, and whose other keys name the part's `INSIDE`. */
const sectionWith = (key: (typeof KEYS)[number], ids: ReadonlyArray<PrdSectionId>) =>
  Array.join(
    Array.flatten([
      ["### A section {#spec.a}", ""],
      Array.map(
        KEYS,
        (name) =>
          `- ${name}: ${Array.join(
            Array.map(name === key ? ids : [INSIDE], (id) => `\`${id}\``),
            ", ",
          )}`,
      ),
      ["", "Prose.", ""],
    ]),
    "\n",
  );

/** The same section as the reply the sections prompt asks for, with its `Under` key first. */
const withUnder = (markdown: string) =>
  String.replace(
    "### A section {#spec.a}\n\n",
    "### A section {#spec.a}\n\n- Under: `spec`\n",
  )(markdown);

const sections = (part: HashSet.HashSet<PrdSectionId> | undefined) =>
  Planner.use((planner) => planner.sections("prd", "spec", [INSIDE], [], part));

const KeyArb = Schema.Literals(KEYS);
const Generated = Schema.Array(PrdSectionId);

it.effect.prop(
  "sections written inside the part come back after one call",
  [KeyArb, Generated],
  ([key, generated]) => {
    const part = partOf(generated);
    const written = sectionWith(key, Array.fromIterable(part));
    return planning(
      [written],
      Effect.gen(function* () {
        const result = yield* sections(part);
        const seen = yield* prompts;
        expect(result).toBe(written);
        expect(seen).toHaveLength(1);
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "a section naming an ID outside the part is sent back once with the error, and a second reply inside it is taken",
  [KeyArb, Generated],
  ([key, generated]) => {
    const part = partOf(generated);
    const good = sectionWith(key, Array.fromIterable(part));
    return planning(
      [sectionWith(key, [OUTSIDE]), good],
      Effect.gen(function* () {
        const result = yield* sections(part);
        const [first = "", second = ""] = yield* prompts;
        expect(result).toBe(good);
        expect(second).toContain(first);
        expect(second).toContain(OUTSIDE);
        expect(second).toContain(`has ${key} naming`);
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "a section that still names an ID outside the part fails with a PlannerError naming it",
  [KeyArb, Generated],
  ([key, generated]) => {
    const part = partOf(generated);
    const bad = sectionWith(key, [OUTSIDE]);
    return planning(
      [bad, bad, sectionWith(key, [INSIDE])],
      Effect.gen(function* () {
        const failure = yield* Effect.flip(sections(part));
        expect(isPlannerError(failure)).toBe(true);
        expect(failure.call).toBe("sections");
        expect(failure.reason).toContain(OUTSIDE);
        expect(failure.reason).toContain(key);
        const seen = yield* prompts;
        expect(seen).toHaveLength(2);
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "a run of the whole PRD takes any IDs in the keys, with one call",
  [KeyArb, Generated],
  ([key, generated]) => {
    const written = sectionWith(key, Array.prepend(generated, OUTSIDE));
    return planning(
      [written],
      Effect.gen(function* () {
        const result = yield* sections(undefined);
        const seen = yield* prompts;
        expect(result).toBe(written);
        expect(seen).toHaveLength(1);
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "a section with an Under key first is checked on the keys after it",
  [KeyArb, Generated],
  ([key, generated]) => {
    const part = partOf(generated);
    expect(Array.length(outsidePartIn(part, withUnder(sectionWith(key, [OUTSIDE]))))).toBe(1);
    expect(outsidePartIn(part, withUnder(sectionWith(key, Array.fromIterable(part))))).toEqual([]);
    return Effect.void;
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "outsidePartIn names each key that reaches outside, once per section and key",
  [Generated],
  ([generated]) => {
    const part = partOf(generated);
    const markdown = Array.join(
      Array.map(KEYS, (key) => sectionWith(key, [OUTSIDE])),
      "\n",
    );
    expect(Array.length(outsidePartIn(part, markdown))).toBe(Array.length(KEYS));
    expect(outsidePartIn(part, sectionWith("Context", Array.fromIterable(part)))).toEqual([]);
    return Effect.void;
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "the sections prompt of a part run lists the part and the Assumes rule, and a whole run does not",
  [Generated],
  ([generated]) => {
    const part = partOf(generated);
    return planning(
      ["## A {#spec.a}\n", "## A {#spec.a}\n"],
      Effect.gen(function* () {
        yield* sections(part);
        yield* sections(undefined);
        const [withPart = "", without = ""] = yield* prompts;
        Array.forEach(Array.fromIterable(part), (id) => {
          expect(withPart).toContain(id);
        });
        expect(withPart).toContain("Assumes:");
        expect(without).not.toContain("Assumes:");
        expect(without).not.toContain("one part of the PRD");
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);

const draftOf = (
  prdSections: Array.NonEmptyReadonlyArray<PrdSectionId>,
  specSections: Array.NonEmptyReadonlyArray<SpecSectionId>,
) =>
  TaskDraft.make({
    category: "feature",
    dependsOn: [],
    files: [],
    model: "sonnet",
    prdSections,
    reasoning: "high",
    specSections,
    title: "A task",
  });

const encodeDrafts = Schema.encodeSync(Schema.fromJsonString(TaskDrafts));
const SPEC = Schema.decodeSync(SpecSectionId)("spec.a");
const OTHER_SPEC = Schema.decodeSync(SpecSectionId)("spec.other");

const tasks = (part: HashSet.HashSet<PrdSectionId> | undefined) =>
  Planner.use((planner) => planner.tasks("prd", "spec", [SPEC], [], part));

it.effect.prop(
  "drafts inside the part and the scope come back after one call",
  [Generated],
  ([generated]) => {
    const part = partOf(generated);
    const drafts = [draftOf(Array.prepend(Array.fromIterable(part), INSIDE), [SPEC])];
    return planning(
      [encodeDrafts({ drafts })],
      Effect.gen(function* () {
        const result = yield* tasks(part);
        const seen = yield* prompts;
        expect(result).toEqual(drafts);
        expect(seen).toHaveLength(1);
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "a draft naming a PRD section outside the part is sent back once with the error, and a second reply inside it is taken",
  [Generated],
  ([generated]) => {
    const part = partOf(generated);
    const good = [draftOf([INSIDE], [SPEC])];
    return planning(
      [
        encodeDrafts({ drafts: [draftOf([INSIDE, OUTSIDE], [SPEC])] }),
        encodeDrafts({ drafts: good }),
      ],
      Effect.gen(function* () {
        const result = yield* tasks(part);
        const [first = "", second = ""] = yield* prompts;
        expect(result).toEqual(good);
        expect(second).toContain(first);
        expect(second).toContain(OUTSIDE);
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "a draft naming a spec section outside the scope fails with a PlannerError after one retry",
  [Generated],
  ([generated]) => {
    const part = partOf(generated);
    const bad = encodeDrafts({ drafts: [draftOf([INSIDE], [SPEC, OTHER_SPEC])] });
    return planning(
      [bad, bad],
      Effect.gen(function* () {
        const failure = yield* Effect.flip(tasks(part));
        expect(isPlannerError(failure)).toBe(true);
        expect(failure.call).toBe("tasks");
        expect(failure.reason).toContain(OTHER_SPEC);
        const seen = yield* prompts;
        expect(seen).toHaveLength(2);
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "a run of the whole PRD takes any IDs in a draft, with one call",
  [Generated],
  ([generated]) => {
    const drafts = [draftOf(Array.prepend(generated, OUTSIDE), [SPEC, OTHER_SPEC])];
    return planning(
      [encodeDrafts({ drafts })],
      Effect.gen(function* () {
        const result = yield* tasks(undefined);
        const seen = yield* prompts;
        expect(result).toEqual(drafts);
        expect(seen).toHaveLength(1);
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);

it.effect.prop(
  "the tasks prompt of a part run lists the part and a whole run does not",
  [Generated],
  ([generated]) => {
    const part = partOf(generated);
    return planning(
      [encodeDrafts({ drafts: [] }), encodeDrafts({ drafts: [] })],
      Effect.gen(function* () {
        yield* tasks(part);
        yield* tasks(undefined);
        const [withPart = "", without = ""] = yield* prompts;
        Array.forEach(Array.fromIterable(part), (id) => {
          expect(withPart).toContain(id);
        });
        expect(withPart).toContain("one part of the PRD");
        expect(without).not.toContain("one part of the PRD");
      }),
    );
  },
  { arbitrary: { runs: 10 } },
);
