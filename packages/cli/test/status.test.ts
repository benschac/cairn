import { Manifest, Sha, SpecSectionId, TaskId } from "@cairn/contract";
import { traceOf } from "@cairn/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, Effect, FileSystem, Layer, Path, Record, Schema, String } from "effect";

import { refreshSnapshot, snapshotText, status, statusLines } from "../src/commands/status.ts";
import { Git, GitHistory } from "../src/git.ts";
import { inputsHashOf, loadTrace, loadTraceInput } from "../src/load-trace.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { TraceStore } from "../src/trace-store.ts";
import { SqlError } from "effect/sql/SqlError";

const PRD = "# Product {#prd.product}\n\n## Store {#prd.store}\n";
const SPEC = "# Spec {#spec.spec}\n\n## Store {#spec.store}\n\n- Implements: `prd.store`\n";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeWide = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 4 }));
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));
const section = Schema.decodeSync(SpecSectionId)("spec.store");
const taskId = Schema.decodeSync(TaskId);

const taskOf = (number: number, parent: string | null, dependsOn: ReadonlyArray<string>) => ({
  branch: `plan/0${number}-task`,
  commits: [],
  dependsOn,
  files: ["src/store.ts"],
  humanGate: { reasons: number === 1 ? ["tag:human"] : [], required: number === 1 },
  id: `t${number}`,
  model: "sonnet",
  parent,
  prdSections: ["prd.store"],
  reasoning: "high",
  sessions: [],
  specSections: ["spec.store"],
  status: "pending",
  title: `Title of t${number}`,
  worktree: null,
});

/** t1 with t2 on top of it, and t3 in a stack of its own that waits for t2. */
const MANIFEST = {
  baseBranch: "main",
  feature: "product",
  tasks: [taskOf(1, null, []), taskOf(2, "t1", ["t1"]), taskOf(3, null, ["t2"])],
  version: 1,
};

/** A fresh main checkout whose `.cairn/` holds the plan and `manifest`, run on an in-memory Git. */
const inCheckout = <A, E>(
  manifest: string,
  extra: Record<string, string>,
  body: (
    root: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Git | GitHistory | MainCheckout>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, ".cairn"), { recursive: true });
      yield* Effect.forEach(
        Record.toEntries({ ...extra, "manifest.json": manifest, "prd.md": PRD, "spec.md": SPEC }),
        ([name, content]) => fs.writeFileString(path.join(root, ".cairn", name), content),
      );
      return yield* body(root).pipe(
        Effect.provide(Layer.mergeAll(MainCheckout.fixed(root), Git.memory())),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const manifestFile = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(root, ".cairn", "manifest.json"));
  });

const traceNow = Effect.map(loadTraceInput, traceOf);

/** t1's branch with one commit carrying its trailer. */
const commitT1 = Effect.gen(function* () {
  const history = yield* GitHistory;
  yield* history.branch("plan/01-task", "main");
  return yield* history.commit("plan/01-task", {
    files: ["src/store.ts"],
    sections: [section],
    session: null,
    subject: "Add the store",
    taskId: taskId("t1"),
  });
});

/** t1's commit squashed onto main, so the base branch reaches it and the task lands. */
const landT1 = Effect.gen(function* () {
  const history = yield* GitHistory;
  yield* commitT1;
  return yield* history.squash("plan/01-task", "main", {
    sections: [section],
    session: null,
    subject: "Add the store",
    taskId: taskId("t1"),
  });
});

it.effect(
  "prints each stack as a tree with branch, model and gate, and names what a task waits for",
  () =>
    inCheckout(encodeJson(MANIFEST), {}, () =>
      Effect.gen(function* () {
        const trace = yield* traceNow;
        expect(statusLines(trace)).toEqual([
          "Stack 1",
          "  t1  pending  Title of t1  plan/01-task  sonnet/high  GATE",
          "    t2  pending  Title of t2  plan/02-task  sonnet/high",
          "Stack 2",
          "  t3  pending  Title of t3  plan/03-task  sonnet/high  waits for t2 to land",
        ]);
      }),
    ),
);

it.effect("marks a task gated by a commit that touches a gated path, as the Trace says", () =>
  inCheckout(encodeJson({ ...MANIFEST, tasks: [taskOf(2, null, [])] }), {}, () =>
    Effect.gen(function* () {
      const history = yield* GitHistory;
      yield* history.branch("plan/02-task", "main");
      yield* history.commit("plan/02-task", {
        files: ["db/migrations/0001.sql"],
        sections: [section],
        session: null,
        subject: "Migrate",
        taskId: taskId("t2"),
      });
      const trace = yield* traceNow;
      expect(trace.tasks[0]?.gate.required).toBe(true);
      expect(statusLines(trace)).toContain(
        "  t2  pending  Title of t2  plan/02-task  sonnet/high  GATE",
      );
    }),
  ),
);

it.effect("a task whose dependency landed no longer waits", () =>
  inCheckout(
    encodeJson({ ...MANIFEST, tasks: [taskOf(1, null, []), taskOf(2, null, ["t1"])] }),
    {},
    () =>
      Effect.gen(function* () {
        yield* landT1;
        const trace = yield* traceNow;
        expect(statusLines(trace)).toContain(
          "  t2  pending  Title of t2  plan/02-task  sonnet/high",
        );
      }),
  ),
);

it.effect("lists the warnings after the stacks", () =>
  inCheckout(encodeJson(MANIFEST), {}, () =>
    Effect.gen(function* () {
      const history = yield* GitHistory;
      yield* history.branch("plan/01-task", "main");
      yield* history.commit("plan/01-task", {
        files: ["src/store.ts"],
        sections: [],
        session: null,
        subject: "No trailers",
        taskId: null,
      });
      const trace = yield* traceNow;
      const lines = statusLines(trace);
      expect(Array.last(lines)).toMatchObject({ value: expect.stringMatching(/^warning: /u) });
    }),
  ),
);

it.effect(
  "refreshes status and commits in manifest.json when git says they changed, and then stops writing",
  () =>
    inCheckout(encodeJson(MANIFEST), {}, (root) =>
      Effect.gen(function* () {
        yield* landT1;
        const before = yield* traceNow;
        yield* status({ json: false });
        const text = yield* manifestFile(root);
        const written = decodeManifest(text);
        const [first] = written.tasks;
        expect(first.status).toBe("landed");
        expect(first.commits).toEqual(Array.map(before.tasks[0]?.commits ?? [], ({ sha }) => sha));
        expect(Array.length(first.commits)).toBeGreaterThan(0);
        const inputs = yield* loadTraceInput;
        const tasks = traceOf(inputs).tasks;
        const again = yield* refreshSnapshot(inputs.manifest, tasks);
        expect(again).toBe(false);
      }),
    ),
);

it.effect("refreshes the status when only an event changed it", () =>
  inCheckout(
    encodeJson(MANIFEST),
    {
      "events.jsonl": `${encodeJson({ status: "running", taskId: "t3", ts: "2026-01-01T00:00:00Z" })}\n`,
    },
    (root) =>
      Effect.gen(function* () {
        yield* status({ json: false });
        const text = yield* manifestFile(root);
        const written = decodeManifest(text);
        expect(Array.map(written.tasks, ({ status: at }) => at)).toEqual([
          "pending",
          "pending",
          "running",
        ]);
      }),
  ),
);

it.effect("leaves manifest.json alone when it already matches", () =>
  inCheckout(`${encodeWide(MANIFEST)}\n`, {}, (root) =>
    Effect.gen(function* () {
      const before = yield* manifestFile(root);
      yield* status({ json: false });
      const after = yield* manifestFile(root);
      expect(after).toBe(before);
    }),
  ),
);

it.effect("--json returns the Trace loadTrace builds", () =>
  inCheckout(encodeJson(MANIFEST), {}, () =>
    Effect.gen(function* () {
      const printed = yield* status({ json: true });
      const loaded = yield* loadTrace;
      expect(printed).toEqual(loaded);
    }),
  ),
);

it.effect("--json carries the notes in cairn.db, as the server's Trace does", () =>
  inCheckout(encodeJson(MANIFEST), {}, () =>
    Effect.gen(function* () {
      const note = yield* Effect.flatMap(TraceStore, (store) =>
        store.addNote({
          anchor: "/task/t1",
          author: "agent:t1",
          body: "Check the empty case.",
          kind: "review",
          resolvedAt: null,
          session: null,
          status: "open",
          task: TaskId.make("t1"),
        }),
      ).pipe(Effect.provide(TraceStore.layer));
      const printed = yield* status({ json: true });
      expect(printed.notes).toEqual([note]);
    }),
  ),
);

it.effect("the tree does not open cairn.db, so one that cannot be read does not stop it", () =>
  inCheckout(encodeJson(MANIFEST), { "cairn.db": "not a database" }, () =>
    Effect.gen(function* () {
      const trace = yield* status({ json: false });
      const json = yield* Effect.flip(status({ json: true }));
      expect(Array.length(trace.tasks)).toBe(Array.length(MANIFEST.tasks));
      expect(json).toBeInstanceOf(SqlError);
    }),
  ),
);

it.effect("the inputs' hash is stable until a commit changes them", () =>
  inCheckout(encodeJson(MANIFEST), {}, () =>
    Effect.gen(function* () {
      const first = yield* loadTraceInput;
      const second = yield* loadTraceInput;
      yield* commitT1;
      const third = yield* loadTraceInput;
      const before = inputsHashOf(first);
      const same = inputsHashOf(second);
      const after = inputsHashOf(third);
      expect(same).toBe(before);
      expect(after).not.toBe(before);
    }),
  ),
);

it("keeps key order and prints arrays that fit on one line, wrapping the ones that do not", () => {
  const long = Array.makeBy(4, (at) => `packages/cli/src/a-long-file-name-${at}.ts`);
  const raw = encodeJson({
    tasks: [{ id: "t1", files: long, status: "pending", commits: [] }],
    version: 1,
  });
  const sha = Schema.decodeSync(Sha)(String.repeat(40)("a"));
  const [task] = decodeManifest(encodeJson({ ...MANIFEST, tasks: [taskOf(1, null, [])] })).tasks;
  const text = snapshotText(raw, [
    {
      ...task,
      commits: [{ files: [], parents: [], sections: [], session: null, sha, subject: "s" }],
      events: [],
      gate: { reasons: [], required: false },
      statements: [],
      status: "done",
      waiting: false,
    },
  ]);
  expect(text).toBe(
    Array.join(
      [
        "{",
        '  "tasks": [',
        "    {",
        '      "id": "t1",',
        '      "files": [',
        '        "packages/cli/src/a-long-file-name-0.ts",',
        '        "packages/cli/src/a-long-file-name-1.ts",',
        '        "packages/cli/src/a-long-file-name-2.ts",',
        '        "packages/cli/src/a-long-file-name-3.ts"',
        "      ],",
        '      "status": "done",',
        `      "commits": ["${sha}"]`,
        "    }",
        "  ],",
        '  "version": 1',
        "}",
        "",
      ],
      "\n",
    ),
  );
});
