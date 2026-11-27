import {
  Config as CairnConfig,
  LinkFromPath,
  Manifest,
  NoteId,
  NoteLabel,
  SessionId,
  SpecSectionId,
  TaskId,
} from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { SqliteMigrator } from "@effect/sql-sqlite-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Record,
  Schema,
  Stdio,
  Stream,
  Struct,
} from "effect";
import { SqlClient } from "effect/sql";
import { ConfigProvider } from "effect";
import { TestConsole } from "effect/testing";

import { DEFAULT_BASE, planOf } from "../src/commands/link.ts";
import { judgeFor, noteAdd, noteResolve } from "../src/commands/note.ts";
import { Git, GitHistory } from "../src/git.ts";
import { Judge, JudgeError } from "../src/judge.ts";
import { LinkArgError, pathOfArgs } from "../src/link-args.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { migration as init } from "../src/migrations/0001_init.ts";
import { migration as notes } from "../src/migrations/0002_notes.ts";
import {
  NoteNotFound,
  SessionNotFound,
  SessionRecord,
  TraceStore,
  sqliteClient,
} from "../src/trace-store.ts";
import { scriptedJudge } from "./scripted-judge.ts";

const PRD = "# Product {#prd.product}\n\n## Code view {#prd.code-view}\n";
const SPEC = "# Spec {#spec.spec}\n\n## Store {#spec.store}\n\n- Implements: `prd.code-view`\n";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownSync(Manifest);
const section = Schema.decodeSync(SpecSectionId)("spec.store");
const taskId = Schema.decodeSync(TaskId);
const sessionId = Schema.decodeSync(SessionId);

const taskOf = (id: string, branch: string) => ({
  branch,
  commits: [],
  dependsOn: [],
  files: ["src/store.ts"],
  humanGate: { reasons: [], required: false },
  id,
  model: "sonnet",
  parent: null,
  prdSections: ["prd.code-view"],
  reasoning: "high",
  sessions: [],
  specSections: ["spec.store"],
  status: "pending",
  title: `Title of ${id}`,
  worktree: null,
});

/** t74, which has a commit, and t76, which has none. */
const MANIFEST = decodeManifest({
  baseBranch: "main",
  feature: "product",
  tasks: [taskOf("t74", "plan/74-task"), taskOf("t76", "plan/76-task")],
  version: 1,
});

/** A fresh main checkout holding the plan, on an in-memory Git with one commit of t74. */
const inCheckout = <A, E>(
  body: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | Git | MainCheckout | Stdio.Stdio | TraceStore
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, ".cairn"), { recursive: true });
      yield* Effect.forEach(
        Record.toEntries({
          "manifest.json": encodeJson(MANIFEST),
          "prd.md": PRD,
          "spec.md": SPEC,
        }),
        ([name, content]) => fs.writeFileString(path.join(root, ".cairn", name), content),
      );
      const git = yield* Layer.build(Git.memory());
      yield* Effect.gen(function* () {
        const history = yield* GitHistory;
        yield* history.branch("plan/74-task", "main");
        yield* history.commit("plan/74-task", {
          files: ["src/store.ts"],
          sections: [section],
          session: null,
          subject: "First",
          taskId: taskId("t74"),
        });
      }).pipe(Effect.provideContext(git));
      return yield* body.pipe(
        Effect.provide(Layer.mergeAll(MainCheckout.fixed(root), TraceStore.layerMemory)),
        Effect.provideContext(git),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

/** The tokens of a review of line 40 of a file in t74's diff, as typed after `cairn note add`. */
const DIFF_LINE = ["t74", "--file", "src/store.ts", "--line", "40"];

const options = {
  author: "agent:t2",
  body: Option.some("Handle the empty case."),
  kind: "review" as const,
  session: Option.none<string>(),
};

const lastLine = Effect.map(TestConsole.logLines, (lines) => Array.last(lines));

it.effect(
  "a review on a diff line stores the anchor cairn link prints, and prints the note's link",
  () =>
    inCheckout(
      Effect.gen(function* () {
        const store = yield* TraceStore;
        const plan = yield* planOf;
        const note = yield* noteAdd({ ...options, tokens: DIFF_LINE });
        const anchor = yield* Effect.fromResult(pathOfArgs(DIFF_LINE, plan));
        expect(anchor).toContain("/task/t74/diff/");
        expect(note).toMatchObject({
          anchor,
          author: "agent:t2",
          body: "Handle the empty case.",
          kind: "review",
          resolvedAt: null,
          session: null,
          status: "open",
          task: "t74",
        });
        const stored = yield* store.notes;
        expect(stored).toEqual([note]);
        const printed = yield* lastLine;
        expect(printed).toEqual(Option.some(`${note.id} ${DEFAULT_BASE}/note/${note.id}`));
        const link = yield* Schema.decodeUnknownEffect(LinkFromPath)(`/note/${note.id}`);
        expect(link).toEqual([{ id: note.id, kind: "note" }]);
      }),
    ),
);

it.effect(
  "the note's own flags are not link arguments, in --flag value and --flag=value form",
  () =>
    inCheckout(
      Effect.gen(function* () {
        const plan = yield* planOf;
        const anchor = yield* Effect.fromResult(pathOfArgs(DIFF_LINE, plan));
        const equals = yield* noteAdd({
          ...options,
          tokens: Array.appendAll(
            [
              "--kind=review",
              "--author=agent:t2",
              "--body=Handle the empty case.",
              "--session=s_abc123",
            ],
            DIFF_LINE,
          ),
        });
        const spaced = yield* noteAdd({
          ...options,
          tokens: Array.appendAll(
            ["--kind", "review", "--author", "agent:t2", "--body", "Handle the empty case."],
            DIFF_LINE,
          ),
        });
        expect([equals.anchor, spaced.anchor]).toEqual([anchor, anchor]);
      }),
    ),
);

it.effect("an unknown task in the link arguments fails with LinkArgError and stores nothing", () =>
  inCheckout(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const error = yield* Effect.flip(noteAdd({ ...options, tokens: ["t999"] }));
      expect(error).toBeInstanceOf(LinkArgError);
      expect(error.message).toBe("unknown task t999");
      const stored = yield* store.notes;
      const printed = yield* TestConsole.logLines;
      expect([stored, printed]).toEqual([[], []]);
    }),
  ),
);

it.effect("a note with no link arguments is refused and stores nothing", () =>
  inCheckout(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const error = yield* Effect.flip(noteAdd({ ...options, tokens: ["--kind", "note"] }));
      const stored = yield* store.notes;
      expect(error).toBeInstanceOf(LinkArgError);
      expect(error.message).toBe("a note needs link arguments to anchor it");
      expect(stored).toEqual([]);
    }),
  ),
);

it.effect("a session with no task among the arguments gives its task, and a stranger fails", () =>
  inCheckout(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const id = sessionId("s_abc123");
      yield* store.put(
        SessionRecord.make({
          agent: null,
          endedAt: null,
          id,
          log: "",
          model: null,
          redactions: {},
          startedAt: null,
          taskId: taskId("t76"),
        }),
      );
      const note = yield* noteAdd({
        ...options,
        session: Option.some(id),
        tokens: ["prd.code-view"],
      });
      expect(note).toMatchObject({ anchor: "/section/prd.code-view", session: id, task: "t76" });
      const withTask = yield* noteAdd({ ...options, session: Option.some(id), tokens: ["t74"] });
      expect(withTask).toMatchObject({ session: id, task: "t74" });
      const error = yield* Effect.flip(
        noteAdd({ ...options, session: Option.some("s_zzzzzz"), tokens: ["prd.code-view"] }),
      );
      expect(error).toEqual(new SessionNotFound({ id: sessionId("s_zzzzzz") }));
      const stored = yield* store.notes;
      // The clock stands still in a test, so notes stored in it tie on `at` and come back in any order.
      expect(stored).toHaveLength(2);
      expect(stored).toContainEqual(note);
      expect(stored).toContainEqual(withTask);
    }),
  ),
);

it.effect("with no body flag the body is standard input", () =>
  inCheckout(
    Effect.gen(function* () {
      const note = yield* noteAdd({ ...options, body: Option.none(), tokens: ["t74"] });
      expect(note.body).toBe("From **stdin**\n");
    }).pipe(
      Effect.provide(
        Stdio.layerTest({ stdin: Stream.encodeText(Stream.make("From **stdin**\n")) }),
      ),
    ),
  ),
);

it.effect("resolve changes only the status and when it was resolved", () =>
  inCheckout(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const note = yield* noteAdd({ ...options, tokens: DIFF_LINE });
      const resolved = yield* noteResolve(note.id);
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved).toEqual(
        Struct.assign(note, {
          resolvedAt: resolved.resolvedAt,
          status: "resolved" as const,
        }),
      );
      expect(resolved.status).toBe("resolved");
      expect(DateTime.isDateTime(resolved.resolvedAt)).toBe(true);
      const stored = yield* store.notes;
      expect(stored).toEqual([resolved]);
      const printed = yield* lastLine;
      expect(printed).toEqual(Option.some(`${note.id} resolved`));
    }),
  ),
);

it.effect("resolving a note that is not stored fails with NoteNotFound", () =>
  inCheckout(
    Effect.gen(function* () {
      const id = Schema.decodeSync(NoteId)("n_abc123def456");
      const error = yield* Effect.flip(noteResolve(id));
      expect(error).toEqual(new NoteNotFound({ id }));
    }),
  ),
);

/** What the scripted judge says of a note whose anchor is t74, whose title is "Title of t74". */
const judgedAs = (label: NoteLabel, confidence: number, actionable: number) =>
  scriptedJudge({
    answer: (title, question) =>
      title === "Title of t74" && question === "label"
        ? Option.some({ confidence, label })
        : Option.none(),
    probability: (_title, question) =>
      question === "actionable" ? Option.some(actionable) : Option.none(),
  });

it.effect("a review that says the code breaks its spec is stored with breaks_spec", () =>
  inCheckout(
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const note = yield* noteAdd({
        ...options,
        body: Option.some("This does not do what the section asks."),
        tokens: DIFF_LINE,
      });
      expect(note.label).toEqual({ label: "breaks_spec", probability: 0.9 });
      expect(note.kind).toBe("review");
      const stored = yield* store.notes;
      expect(stored).toEqual([note]);
    }).pipe(Effect.provide(judgedAs("breaks_spec", 0.9, 0.9))),
  ),
);

const Probabilities = Schema.Literals([0, 0.1, 0.25, 0.3, 0.45, 0.5, 0.7, 0.95, 1]);

it.effect.prop(
  "a label is stored at or above judge.minProbability, and a change-asking one only when the note is actionable",
  [NoteLabel, Probabilities, Probabilities],
  ([label, confidence, actionable]) =>
    inCheckout(
      Effect.gen(function* () {
        const note = yield* noteAdd({ ...options, tokens: DIFF_LINE });
        const asksForChange = Array.contains(["blocker", "bug", "breaks_spec"], label);
        const kept = confidence >= 0.5 && !(asksForChange && actionable < 0.3);
        expect(note.label).toEqual(kept ? { label, probability: confidence } : null);
        expect(note.kind).toBe("review");
      }).pipe(Effect.provide(judgedAs(label, confidence, actionable))),
    ),
  { arbitrary: { runs: 25 } },
);

it.effect("a low-probability label is stored as null", () =>
  inCheckout(
    Effect.gen(function* () {
      const note = yield* noteAdd({ ...options, tokens: DIFF_LINE });
      expect(note.label).toBeNull();
      const stored = yield* (yield* TraceStore).notes;
      expect(stored[0]?.label).toBeNull();
    }).pipe(Effect.provide(judgedAs("bug", 0.4, 0.9))),
  ),
);

it.effect("a judge error stores the note without a label and warns on standard error", () =>
  inCheckout(
    Effect.gen(function* () {
      const note = yield* noteAdd({ ...options, tokens: DIFF_LINE });
      expect(note).toMatchObject({ body: "Handle the empty case.", label: null });
      const stored = yield* (yield* TraceStore).notes;
      expect(stored).toEqual([note]);
      const warnings = yield* TestConsole.errorLines;
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0])).toContain("the model is down");
    }).pipe(
      Effect.provide(
        Layer.succeed(
          Judge,
          Judge.of({
            ask: () => Effect.fail(new JudgeError({ reason: "the model is down" })),
            judge: () => Effect.fail(new JudgeError({ reason: "the model is down" })),
          }),
        ),
      ),
    ),
  ),
);

it.effect("with no judge the label is null and nothing is warned", () =>
  inCheckout(
    Effect.gen(function* () {
      const note = yield* noteAdd({ ...options, tokens: DIFF_LINE });
      expect(note.label).toBeNull();
      const warnings = yield* TestConsole.errorLines;
      expect(warnings).toEqual([]);
    }),
  ),
);

it.effect("a database from before labels migrates, and its notes have null labels", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const filename = path.join(directory, "cairn.db");
    yield* Effect.gen(function* () {
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({ "0001_init": init, "0002_notes": notes }),
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`insert into notes ${sql.insert({
        anchor: "/task/t74",
        at: "2026-11-25T11:00:00.000Z",
        author: "agent:t2",
        body: "Older",
        id: "n_older0000001",
        kind: "note",
        resolvedAt: null,
        session: null,
        status: "open",
        task: "t74",
      })}`;
    }).pipe(Effect.provide(sqliteClient(filename)));
    const stored = yield* Effect.flatMap(TraceStore, (store) => store.notes).pipe(
      Effect.provide(TraceStore.layerAt(filename)),
    );
    expect(Array.map(stored, ({ body, label }) => [body, label])).toEqual([["Older", null]]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a judge that cannot be built warns and stores the note without a label", () =>
  inCheckout(
    Effect.gen(function* () {
      const config = Schema.decodeSync(CairnConfig)({
        judge: { baseUrl: "https://gateway.example", gatewayTokenEnv: "CAIRN_UNSET_TOKEN" },
      });
      const note = yield* noteAdd({ ...options, tokens: DIFF_LINE }).pipe(
        Effect.provide(
          judgeFor(config).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
          ),
        ),
      );
      expect(note.label).toBeNull();
      const warnings = yield* TestConsole.errorLines;
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0])).toContain("CAIRN_UNSET_TOKEN");
    }),
  ),
);
