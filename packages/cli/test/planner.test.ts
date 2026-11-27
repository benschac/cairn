import {
  IndexProse,
  Manifest,
  PrdSectionId,
  Slug,
  SpecSectionId,
  TaskDraft,
  defaultConfig,
} from "@cairn/contract";
import type { Config } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Predicate,
  Record,
  Schema,
  String,
  Struct,
} from "effect";
import { Chat } from "effect/ai";
import { TestClock, TestConsole } from "effect/testing";

import { Planner, PlannerError, StatementDrafts, TaskDrafts } from "../src/planner.ts";
import { Script, scripted, turnsOf, unreachable } from "./fixtures/scripted-language-model.ts";
import type { Reply } from "./fixtures/scripted-language-model.ts";

/**
 * Runs `program` against a planner whose model plays `replies`. The program can read the prompts
 * the model was given from `Script`.
 */
const planningIn = <A, E>(
  config: Pick<Config, "categories" | "judge">,
  replies: ReadonlyArray<string | Reply>,
  program: Effect.Effect<A, E, Planner | Script>,
) =>
  program.pipe(
    Effect.provide(
      Planner.layerWith(config).pipe(
        Layer.provide(NodeServices.layer),
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

const planning = <A, E>(
  replies: ReadonlyArray<string | Reply>,
  program: Effect.Effect<A, E, Planner | Script>,
) => planningIn(defaultConfig, replies, program);

/** A draft whose category is one of the config's defaults, which is what the planner accepts. */
const Draft = TaskDraft.mapFields(
  Struct.assign({
    category: Schema.Literals(Array.map(defaultConfig.categories, ({ name }) => name)),
  }),
);

const encodeReply = Schema.encodeSync(Schema.fromJsonString(TaskDrafts));
const prompts = Script.use((script) => script.prompts);
/** Each request the model was given, as its messages' roles and texts. */
const conversations = Script.use((script) => Effect.map(script.requests, Array.map(turnsOf)));

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
      category: "feature",
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

const fence = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\``;

const spec = (prd: string) => Planner.use((planner) => planner.spec(prd));
const tasks = (prd: string, specText: string) =>
  Planner.use((planner) => planner.tasks(prd, specText, [], []));

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

/**
 * A logger that prints only a line's annotations to stderr, and a console that keeps them: the
 * lines the planner logs are read from `TestConsole.errorLines`.
 */
const logged = Layer.merge(
  TestConsole.layer,
  Logger.layer([
    Logger.withConsoleError(Logger.map(Logger.formatStructured, (entry) => entry.annotations)),
  ]),
);

/** How long a model call takes in a test: up to an hour, in whole seconds. */
const Seconds = Schema.Int.check(Schema.isBetween({ maximum: 3600, minimum: 1 }));

it.effect.prop(
  "a model call logs how long it took and the sizes of its prompt and reply",
  [Schema.NonEmptyString, Schema.String, Seconds],
  ([prd, markdown, seconds]) =>
    planning(
      [Effect.delay(Effect.succeed(markdown), Duration.seconds(seconds))],
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(spec(prd));
        yield* TestClock.adjust(Duration.seconds(seconds));
        yield* Fiber.join(fiber);
        const [prompt = ""] = yield* prompts;
        const lines = yield* TestConsole.errorLines;
        expect(lines).toEqual([
          {
            call: "spec",
            outcome: "ok",
            promptChars: String.length(prompt),
            replyChars: String.length(markdown),
            seconds,
          },
        ]);
      }),
    ).pipe(Effect.provide(logged)),
);

it.effect.prop(
  "a reply that does not decode logs a failed call, and its retry logs a call of its own",
  [Schema.Array(Draft), Schema.NonEmptyString],
  ([drafts, bad]) => {
    const good = encodeReply({ drafts });
    return planning(
      [bad, good],
      Effect.gen(function* () {
        yield* tasks("prd", "spec");
        const [, second = []] = yield* conversations;
        const [first = ""] = yield* prompts;
        // A retry is a follow-up turn of the same chat: the line counts the turn it sent.
        const retry = Option.getOrElse(
          Option.map(Array.last(second), Struct.get("text")),
          () => "",
        );
        const lines = yield* TestConsole.errorLines;
        expect(lines).toEqual([
          {
            call: "tasks",
            outcome: "failed",
            promptChars: String.length(first),
            replyChars: 0,
            seconds: 0,
          },
          {
            call: "tasks",
            outcome: "ok",
            promptChars: String.length(retry),
            replyChars: String.length(good),
            seconds: 0,
          },
        ]);
      }),
    ).pipe(Effect.provide(logged));
  },
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
  [Schema.Array(Draft)],
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
  [Schema.Array(Draft), Schema.NonEmptyString],
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

it.effect.prop(
  "a draft with a category the config lacks is refused, and accepted once the config adds it",
  [Draft],
  ([draft]) => {
    const infra = Struct.assign({ category: "infra" })(draft);
    const reply = Schema.encodeSync(
      Schema.fromJsonString(Schema.Struct({ drafts: Schema.Array(Schema.Unknown) })),
    )({
      drafts: [infra],
    });
    const added = Struct.assign({
      categories: Array.append(defaultConfig.categories, {
        description: "Infrastructure",
        name: Schema.decodeSync(Slug)("infra"),
      }),
    })(defaultConfig);
    return Effect.gen(function* () {
      const failure = yield* planning([reply, reply], Effect.flip(tasks("prd", "spec")));
      expect(isPlannerError(failure)).toBe(true);
      expect(failure.reason).toContain("infra");
      const planned = yield* planningIn(added, [reply], tasks("prd", "spec"));
      expect(planned).toEqual([infra]);
    });
  },
);

it.effect(
  "the tasks prompt lists each category with its description, and a refusal is retried once with the list",
  () =>
    planning(
      ['{"drafts":[{"title":"No category"}]}', encodeReply({ drafts: [] })],
      Effect.gen(function* () {
        yield* tasks("prd", "spec");
        const [first = "", second = ""] = yield* prompts;
        yield* Effect.forEach(defaultConfig.categories, ({ description, name }) =>
          Effect.sync(() => expect(first).toContain(`- \`${name}\`: ${description}`)),
        );
        expect(second).toContain('["category"]');
      }),
    ),
);

it.effect.prop(
  "a retried call's second request holds the first prompt and the refused reply, and only the error as its new turn",
  [Schema.Array(Draft), Schema.String],
  ([drafts, text]) => {
    // A reply with text: a blank one is left out of the history (see the test below).
    const bad = `refused ${text}`;
    return planning(
      [bad, encodeReply({ drafts })],
      Effect.gen(function* () {
        yield* tasks("prd", "spec");
        const [first = [], second = []] = yield* conversations;
        const [asked = { role: "user", text: "" }] = first;
        expect(Array.take(second, Array.length(first) + 1)).toEqual(
          Array.append(first, { role: "assistant", text: bad }),
        );
        expect(Array.length(second)).toBe(Array.length(first) + 2);
        const retry = Option.getOrElse(
          Option.map(Array.last(second), Struct.get("text")),
          () => "",
        );
        expect(retry).toContain("Your previous reply was refused");
        expect(retry).toContain("Structured output validation failed");
        expect(retry).not.toContain(asked.text);
      }),
    );
  },
);

it.effect.prop(
  "a structured reply with no text is retried without an empty assistant turn, which a provider refuses",
  [Schema.Array(Draft), Schema.Literals(["", " ", "\n"])],
  ([drafts, blank]) =>
    planning(
      [blank, encodeReply({ drafts })],
      Effect.gen(function* () {
        yield* tasks("prd", "spec");
        const [first = [], second = []] = yield* conversations;
        expect(Array.take(second, Array.length(first))).toEqual(first);
        expect(Array.length(second)).toBe(Array.length(first) + 1);
        expect(Array.some(second, ({ role }) => role === "assistant")).toBe(false);
      }),
    ),
);

it.effect(
  "a Mermaid block that does not draw goes back in the same chat, after the first prompt and reply, with only its error",
  () => {
    const undrawn = `## A {#spec.a}\n\n${fence("flowchart TD\n  a --")}\n`;
    return planning(
      [undrawn, `## A {#spec.a}\n\n${fence("flowchart TD\n  a --> b")}\n`],
      Effect.gen(function* () {
        yield* spec("prd");
        const [first = [], second = []] = yield* conversations;
        const [asked = { role: "user", text: "" }] = first;
        expect(Array.length(first)).toBe(1);
        expect(Array.take(second, 2)).toEqual([asked, { role: "assistant", text: undrawn }]);
        const retry = Option.getOrElse(
          Option.map(Array.get(second, 2), Struct.get("text")),
          () => "",
        );
        expect(Array.length(second)).toBe(3);
        expect(retry).toContain("does not draw");
        expect(retry).not.toContain(asked.text);
      }),
    );
  },
);

it.effect("the retry prompt holds the decode error of the first reply", () =>
  planning(
    ['{"drafts":[{"title":"No other fields"}]}', encodeReply({ drafts: [] })],
    Effect.gen(function* () {
      yield* tasks("prd", "spec");
      const [first = "", second = ""] = yield* prompts;
      expect(first).not.toContain('["category"]');
      expect(second).toContain('["category"]');
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

const splitSection = (section: string, reason: string) =>
  Planner.use((planner) => planner.splitSection(section, reason));
/** A split asked in the trunk `splitTrunk` opens with `specText`, as `refine` asks one. */
const splitTask = (draft: TaskDraft, specText: string, reason: string) =>
  Planner.use((planner) =>
    planner
      .splitTask(draft, reason)
      .pipe(Effect.provideServiceEffect(Chat.Chat, planner.splitTrunk(specText))),
  );
const indexOf = (id: SpecSectionId, title: string, body: string) =>
  Planner.use((planner) => planner.index({ body, id, title }));

it.effect.prop(
  "splitSection returns the model's markdown, and the prompt holds the section and the reason",
  [Schema.NonEmptyString, Schema.NonEmptyString, Schema.String],
  ([section, reason, markdown]) =>
    planning(
      [markdown],
      Effect.gen(function* () {
        const written = yield* splitSection(section, reason);
        const seen = yield* prompts;
        const [first = ""] = seen;
        expect(written).toBe(markdown);
        expect(seen).toHaveLength(1);
        expect(first).toContain(section);
        expect(first).toContain(reason);
      }),
    ),
);

it.effect("a model failure while splitting a section is a PlannerError", () =>
  planning(
    [unreachable],
    Effect.gen(function* () {
      const failure = yield* Effect.flip(splitSection("## A {#spec.a}", "too big"));
      expect(isPlannerError(failure)).toBe(true);
      expect(failure.call).toBe("splitSection");
    }),
  ),
);

/** The drafts a split returns: two, then any more. */
const splitOf = (one: TaskDraft, two: TaskDraft, rest: ReadonlyArray<TaskDraft>) =>
  Array.appendAll([one, two], rest);

/** A string as it is written in JSON, with its quotes. */
const jsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

it.effect.prop(
  "splitTask returns the two or more drafts the model sent, and the prompt holds the draft, the spec and the reason",
  [Draft, Schema.NonEmptyString, Schema.NonEmptyString, Draft, Draft, Schema.Array(Draft)],
  ([draft, specText, reason, one, two, rest]) => {
    const drafts = splitOf(one, two, rest);
    return planning(
      [encodeReply({ drafts })],
      Effect.gen(function* () {
        const split = yield* splitTask(draft, specText, reason);
        const seen = yield* prompts;
        const [first = ""] = seen;
        expect(split).toEqual(drafts);
        expect(seen).toHaveLength(1);
        expect(first).toContain(jsonString(draft.title));
        expect(first).toContain(specText);
        expect(first).toContain(reason);
      }),
    );
  },
);

it.effect.prop(
  "a split into fewer than two drafts is retried once with the reason in the prompt, then fails",
  [Draft, Schema.NonEmptyString, Schema.Array(Draft).check(Schema.isMaxLength(1))],
  ([draft, reason, drafts]) =>
    planning(
      [encodeReply({ drafts }), encodeReply({ drafts }), encodeReply({ drafts: [draft, draft] })],
      Effect.gen(function* () {
        const failure = yield* Effect.flip(splitTask(draft, "spec", reason));
        const seen = yield* prompts;
        const [first = "", second = ""] = seen;
        expect(isPlannerError(failure)).toBe(true);
        expect(failure.call).toBe("splitTask");
        expect(seen).toHaveLength(2);
        expect(second).toContain(first);
        expect(second).toContain("Expected a value with a length of at least 2");
      }),
    ),
);

it.effect.prop(
  "splitTask recovers when the retry decodes",
  [Draft, Draft, Draft, Schema.Array(Draft)],
  ([draft, one, two, rest]) =>
    planning(
      ["not json", encodeReply({ drafts: splitOf(one, two, rest) })],
      Effect.gen(function* () {
        const split = yield* splitTask(draft, "spec", "reason");
        const seen = yield* prompts;
        expect(split).toEqual(splitOf(one, two, rest));
        expect(seen).toHaveLength(2);
      }),
    ),
);

it.effect.prop(
  "a model failure while splitting a task is a PlannerError, with no second try",
  [Draft],
  ([draft]) =>
    planning(
      [unreachable, encodeReply({ drafts: [draft, draft] })],
      Effect.gen(function* () {
        const failure = yield* Effect.flip(splitTask(draft, "spec", "reason"));
        expect(isPlannerError(failure)).toBe(true);
        const seen = yield* prompts;
        expect(failure.call).toBe("splitTask");
        expect(seen).toHaveLength(1);
      }),
    ),
);

/**
 * An `IndexProse` whose item IDs belong to section `id`. The generator makes IDs for any
 * section, so they are numbered over again under `id`.
 */
const proseOf = (id: SpecSectionId, prose: IndexProse): IndexProse => ({
  artifacts: Array.map(prose.artifacts, (item, index) => ({
    ...item,
    id: `${id}#${item.kind}:item-${index}`,
  })),
  decisions: Array.map(prose.decisions, (item, index) => ({ ...item, id: `${id}#d${index + 1}` })),
  requirements: Array.map(prose.requirements, (item, index) => ({
    ...item,
    id: `${id}#r${index + 1}`,
  })),
  summary: prose.summary,
  tests: Array.map(prose.tests, (item, index) => ({ ...item, id: `${id}#t${index + 1}` })),
});

const encodeProse = Schema.encodeSync(Schema.fromJsonString(IndexProse));

it.effect.prop(
  "index returns the prose fields the model sent, and the prompt holds the section's ID, title and body",
  [SpecSectionId, Schema.NonEmptyString, Schema.NonEmptyString, IndexProse],
  ([id, title, body, generated]) => {
    const prose = proseOf(id, generated);
    return planning(
      [encodeProse(prose)],
      Effect.gen(function* () {
        const indexed = yield* indexOf(id, title, body);
        const seen = yield* prompts;
        const [first = ""] = seen;
        expect(indexed).toEqual(prose);
        expect(seen).toHaveLength(1);
        expect(first).toContain(id);
        expect(first).toContain(title);
        expect(first).toContain(body);
      }),
    );
  },
);

it.effect.prop(
  "an index reply with an item ID from another section is retried once, then fails with the IDs named",
  [SpecSectionId, IndexProse],
  ([id, generated]) => {
    const prose = proseOf(id, generated);
    const foreign = {
      ...prose,
      decisions: Array.prepend(prose.decisions, {
        id: `${id}-other#d1`,
        text: "a choice",
        why: null,
      }),
    } satisfies IndexProse;
    return planning(
      [encodeProse(foreign), encodeProse(foreign), encodeProse(prose)],
      Effect.gen(function* () {
        const failure = yield* Effect.flip(indexOf(id, "Title", "Body"));
        const seen = yield* prompts;
        const [first = "", second = ""] = seen;
        expect(isPlannerError(failure)).toBe(true);
        expect(failure.call).toBe("index");
        expect(failure.reason).toContain(`${id}-other#d1`);
        expect(seen).toHaveLength(2);
        expect(second).toContain(first);
        expect(second).toContain(`${id}-other#d1`);
      }),
    );
  },
);

it.effect.prop("a model failure while indexing is a PlannerError", [SpecSectionId], ([id]) =>
  planning(
    [unreachable],
    Effect.gen(function* () {
      const failure = yield* Effect.flip(indexOf(id, "A", "Body"));
      expect(isPlannerError(failure)).toBe(true);
      expect(failure.call).toBe("index");
    }),
  ),
);

const sections = (
  prd: string,
  specText: string,
  prdSections: ReadonlyArray<PrdSectionId>,
  rewrite: ReadonlyArray<SpecSectionId>,
) => Planner.use((planner) => planner.sections(prd, specText, prdSections, rewrite));

it.effect.prop(
  "sections returns the model's markdown, and the prompt holds the PRD, the spec and the IDs",
  [
    Schema.NonEmptyString,
    Schema.NonEmptyString,
    Schema.Array(PrdSectionId),
    Schema.Array(SpecSectionId),
    Schema.String,
  ],
  ([prd, specText, prdSections, rewrite, markdown]) =>
    planning(
      [markdown],
      Effect.gen(function* () {
        const written = yield* sections(prd, specText, prdSections, rewrite);
        const seen = yield* prompts;
        const [first = ""] = seen;
        expect(written).toBe(markdown);
        expect(seen).toHaveLength(1);
        expect(first).toContain(prd);
        expect(first).toContain(specText);
        Array.forEach(prdSections, (id) => {
          expect(first).toContain(id);
        });
        Array.forEach(rewrite, (id) => {
          expect(first).toContain(id);
        });
      }),
    ),
);

it.effect("a model failure while writing sections is a PlannerError", () =>
  planning(
    [unreachable],
    Effect.gen(function* () {
      const failure = yield* Effect.flip(sections("prd", "spec", [], []));
      expect(isPlannerError(failure)).toBe(true);
      expect(failure.call).toBe("sections");
    }),
  ),
);

it.effect("a Mermaid block in sections that does not draw is sent back once with its error", () =>
  planning(
    [
      `## A {#spec.a}\n\n${fence("flowchart TD\n  a --")}\n`,
      `## A {#spec.a}\n\n${fence("flowchart TD\n  a --> b")}\n`,
    ],
    Effect.gen(function* () {
      const written = yield* sections("prd", "spec", [], []);
      const [first = "", second = ""] = yield* prompts;
      expect(written).toContain("a --> b");
      expect(second).toContain(first);
      expect(second).toContain("spec.a");
      expect(second).toContain("does not draw");
    }),
  ),
);

it.effect(
  "a Mermaid block in sections that still does not draw is left out, with the section named",
  () =>
    planning(
      [
        `## A {#spec.a}\n\n${fence("flowchart TD\n  a --")}\n`,
        `## A {#spec.a}\n\n${fence("flowchart TD\n  a --")}\n`,
      ],
      Effect.gen(function* () {
        const written = yield* sections("prd", "spec", [], []);
        const seen = yield* prompts;
        expect(written).not.toContain("mermaid");
        expect(seen).toHaveLength(2);
      }),
    ),
);

it.effect.prop(
  "tasks prompts with the spec sections to draft and the tasks that exist, which a draft may depend on",
  [Schema.Array(SpecSectionId).check(Schema.isMinLength(1))],
  ([specSections]) =>
    Effect.gen(function* () {
      const manifestJson = yield* read("../../../.cairn/manifest.json");
      const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(manifestJson);
      const existing = Array.take(manifest.tasks, 3);
      yield* planning(
        [encodeReply({ drafts: [] })],
        Effect.gen(function* () {
          yield* Planner.use((planner) => planner.tasks("prd", "spec", specSections, existing));
          const [first = ""] = yield* prompts;
          Array.forEach(specSections, (id) => {
            expect(first).toContain(id);
          });
          Array.forEach(existing, (task) => {
            expect(first).toContain(task.id);
            expect(first).toContain(task.title);
          });
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

const statementsOf = (prd: string, targets: ReadonlyArray<PrdSectionId>) =>
  Planner.use((planner) => planner.statements(prd, targets));

const encodeStatements = Schema.encodeSync(Schema.fromJsonString(StatementDrafts));

it.effect.prop(
  "statements returns the drafts the model sent, and the prompt holds the PRD and every target",
  [PrdSectionId, Schema.NonEmptyString, Schema.Array(Schema.String)],
  ([first, prd, drafts]) => {
    const second = Schema.decodeSync(PrdSectionId)(`${first}-second`);
    return planning(
      [
        encodeStatements({
          statements: [
            { drafts, target: first },
            { drafts: [], target: second },
          ],
        }),
      ],
      Effect.gen(function* () {
        const found = yield* statementsOf(prd, [first, second]);
        const seen = yield* prompts;
        const [prompt = ""] = seen;
        expect(found).toEqual([
          { drafts, target: first },
          { drafts: [], target: second },
        ]);
        expect(seen).toHaveLength(1);
        expect(prompt).toContain(prd);
        expect(prompt).toContain(first);
        expect(prompt).toContain(second);
      }),
    );
  },
);

it.effect.prop(
  "a statements reply about a part that was not asked about is retried once, then fails with it named",
  [PrdSectionId],
  ([asked]) => {
    const other = Schema.decodeSync(PrdSectionId)(`${asked}-other`);
    const foreign = encodeStatements({ statements: [{ drafts: ["A."], target: other }] });
    return planning(
      [foreign, foreign],
      Effect.gen(function* () {
        const failure = yield* Effect.flip(statementsOf("# Notes", [asked]));
        const seen = yield* prompts;
        const [first = "", second = ""] = seen;
        expect(isPlannerError(failure)).toBe(true);
        expect(failure.call).toBe("statements");
        expect(failure.reason).toContain(other);
        expect(seen).toHaveLength(2);
        expect(second).toContain(first);
        expect(second).toContain(other);
      }),
    );
  },
);

it.effect.prop(
  "a model failure while drafting statements is a PlannerError",
  [PrdSectionId],
  ([id]) =>
    planning(
      [unreachable],
      Effect.gen(function* () {
        const failure = yield* Effect.flip(statementsOf("# Notes", [id]));
        expect(isPlannerError(failure)).toBe(true);
        expect(failure.call).toBe("statements");
      }),
    ),
);

it.effect.prop(
  "a statements reply that skips a target or repeats one is retried once, then fails with it named",
  [PrdSectionId],
  ([asked]) => {
    const other = Schema.decodeSync(PrdSectionId)(`${asked}-other`);
    const skipped = encodeStatements({ statements: [{ drafts: [], target: asked }] });
    const repeated = encodeStatements({
      statements: [
        { drafts: [], target: asked },
        { drafts: [], target: asked },
        { drafts: [], target: other },
      ],
    });
    return planning(
      [skipped, repeated],
      Effect.gen(function* () {
        const failure = yield* Effect.flip(statementsOf("# Notes", [asked, other]));
        const seen = yield* prompts;
        const [, second = ""] = seen;
        expect(failure.call).toBe("statements");
        expect(failure.reason).toContain(`more than one item: ${asked}`);
        expect(seen).toHaveLength(2);
        expect(second).toContain(`no item: ${other}`);
      }),
    );
  },
);
