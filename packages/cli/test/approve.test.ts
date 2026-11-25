import { EventJson } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, Effect, FileSystem, Layer, Option, Path, Record, Schema, String } from "effect";

import { approve, ApprovalRefused } from "../src/commands/approve.ts";
import { Git } from "../src/git.ts";
import { loadEvents } from "../src/workspace.ts";
import { MainCheckout } from "../src/main-checkout.ts";

const PRD = "# Product {#prd.product}\n\n## Store {#prd.store}\n";
const SPEC = "# Spec {#spec.spec}\n\n## Store {#spec.store}\n\n- Implements: `prd.store`\n";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownSync(EventJson);

const taskOf = (number: number, gated: boolean) => ({
  branch: `plan/0${number}-task`,
  commits: [],
  dependsOn: [],
  files: ["src/store.ts"],
  humanGate: { reasons: gated ? ["tag:human"] : [], required: gated },
  id: `t${number}`,
  model: "sonnet",
  parent: null,
  prdSections: ["prd.store"],
  reasoning: "high",
  sessions: [],
  specSections: ["spec.store"],
  status: "pending",
  title: `Title of t${number}`,
  worktree: null,
});

/** t1 is gated, t2 is not, t3 is gated and t4 is gated and done. */
const MANIFEST = encodeJson({
  baseBranch: "main",
  feature: "product",
  tasks: [taskOf(1, true), taskOf(2, false), taskOf(3, true), taskOf(4, true)],
  version: 1,
});

/** An event `minute` minutes into 2026, so events sort in the order the fixture lists them. */
const event = (minute: number, taskId: string, status: string, actor = "orchestrator") =>
  encodeJson({
    actor,
    status,
    taskId,
    ts: `2026-01-01T00:${String.padStart(2, "0")(`${minute}`)}:00Z`,
    v: 1,
  });

/** t1 and t4 finished, so a gate holds them; t4 was then approved; t2 runs. */
const EVENTS = Array.join(
  [
    event(1, "t1", "running"),
    event(2, "t1", "done"),
    event(3, "t4", "running"),
    event(4, "t4", "done"),
    event(5, "t4", "done", "human:Ada"),
    event(6, "t2", "running"),
  ],
  "\n",
);

const inCheckout = <A, E>(
  files: Record<string, string>,
  userName: Option.Option<string>,
  body: (
    root: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Git | MainCheckout>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, ".cairn"), { recursive: true });
      yield* Effect.forEach(
        Record.toEntries({ "manifest.json": MANIFEST, "prd.md": PRD, "spec.md": SPEC, ...files }),
        ([name, content]) => fs.writeFileString(path.join(root, ".cairn", name), content),
      );
      return yield* body(root).pipe(
        Effect.provide(Layer.mergeAll(MainCheckout.fixed(root), Git.memory("main", userName))),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const eventsFile = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(root, ".cairn", "events.jsonl");
    return (yield* fs.exists(file)) ? yield* fs.readFileString(file) : "";
  });

const ada = Option.some("Ada");

it.live("approves a gated task in blocked_on_human and prints its new status", () =>
  inCheckout({ "events.jsonl": `${EVENTS}\n` }, ada, (root) =>
    Effect.gen(function* () {
      const before = yield* eventsFile(root);
      const status = yield* approve("t1");
      expect(status).toBe("done");
      const after = yield* eventsFile(root);
      expect(String.startsWith(before)(after)).toBe(true);
      const added = Array.filter(
        String.split(String.slice(before.length)(after), "\n"),
        String.isNonEmpty,
      );
      expect(Array.length(added)).toBe(1);
      const [line] = added;
      expect(decodeEvent(line)).toMatchObject({ actor: "human:Ada", status: "done", taskId: "t1" });
      const events = yield* loadEvents;
      expect(Array.length(events)).toBe(7);
    }),
  ),
);

it.live("creates events.jsonl when it is missing", () =>
  inCheckout(
    { "events.jsonl": `${event(1, "t1", "running")}\n${event(2, "t1", "done")}` },
    ada,
    (root) =>
      Effect.gen(function* () {
        // A file without a final newline keeps its last event on its own line.
        yield* approve("t1");
        const text = yield* eventsFile(root);
        const lines = Array.filter(String.split(text, "\n"), String.isNonEmpty);
        expect(Array.length(lines)).toBe(3);
      }),
  ),
);

it.live("refuses a task that is not blocked_on_human and says its status", () =>
  inCheckout({ "events.jsonl": `${EVENTS}\n` }, ada, (root) =>
    Effect.gen(function* () {
      const before = yield* eventsFile(root);
      const refusals = yield* Effect.forEach(["t3", "t2", "t4"], (id) => Effect.flip(approve(id)));
      expect(Array.map(refusals, (error) => error.message)).toEqual([
        expect.stringContaining("t3 is pending, not blocked_on_human"),
        expect.stringContaining("t2 is running, not blocked_on_human"),
        expect.stringContaining("t4 is done, not blocked_on_human"),
      ]);
      const after = yield* eventsFile(root);
      expect(after).toBe(before);
    }),
  ),
);

it.live("refuses a landed task", () =>
  inCheckout(
    { "events.jsonl": `${event(1, "t2", "running")}\n${event(2, "t2", "landed")}\n` },
    ada,
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(approve("t2"));
        expect(error.message).toContain("t2 is landed, not blocked_on_human");
      }),
  ),
);

it.live("refuses an unknown task id", () =>
  inCheckout({}, ada, (root) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(approve("t99"));
      expect(error).toBeInstanceOf(ApprovalRefused);
      expect(error.message).toContain("t99 is not a task");
      const after = yield* eventsFile(root);
      expect(after).toBe("");
    }),
  ),
);

it.live("refuses when git user.name is unset, writing nothing", () =>
  inCheckout({ "events.jsonl": `${EVENTS}\n` }, Option.none(), (root) =>
    Effect.gen(function* () {
      const before = yield* eventsFile(root);
      const error = yield* Effect.flip(approve("t1"));
      expect(error.message).toContain("user.name");
      const after = yield* eventsFile(root);
      expect(after).toBe(before);
    }),
  ),
);
