import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";

import { Event, Manifest, SessionId, TaskId, defaultConfig } from "@cairn/contract";
import type { TaskStatus } from "@cairn/contract";
import { GitCommit, derive } from "@cairn/core";
import { Array, DateTime, Option, Schema, String } from "effect";

import { eventsOf, firstDifference, latest, parseShown, SHOW_FORMAT } from "./plan.ts";

const id = Schema.decodeSync(TaskId)("t1");
const session = Schema.decodeSync(SessionId)("s_abcdef");
const at = DateTime.makeUnsafe("2026-11-24T17:56:11.000Z");

await test("parseShown reads each commit's sha, parents, subject, time and files", () => {
  const output = Array.join(
    [
      "\x01aaa",
      "p1 p2",
      "Merge it",
      "2026-11-24T12:56:11-05:00",
      "",
      "a.ts",
      "b/c.ts",
      "\x01bbb",
      "",
      "Root commit",
      "2026-11-24T12:56:11-05:00",
      "",
    ],
    "\n",
  );
  const [merge, root] = parseShown(output);
  assert.deepEqual(merge?.parents, ["p1", "p2"]);
  assert.deepEqual(merge?.files, ["a.ts", "b/c.ts"]);
  assert.equal(merge?.subject, "Merge it");
  assert.equal(DateTime.formatIso(merge?.ts ?? at), "2026-11-24T17:56:11.000Z");
  assert.deepEqual(root?.parents, []);
  assert.deepEqual(root?.files, []);
  assert.ok(String.startsWith("%x01")(SHOW_FORMAT));
});

await test("eventsOf gives a done task running then done, and a gated one a human approval", () => {
  const done = eventsOf(
    { id, model: "sonnet", reasoning: "low", sessions: [session], status: "done" },
    false,
    "human:ann",
    at,
  );
  assert.deepEqual(
    Array.map(done, (event) => [event.status, event.actor]),
    [
      ["running", "orchestrator"],
      ["done", "orchestrator"],
    ],
  );
  const gated = eventsOf(
    { id, model: "sonnet", reasoning: "low", sessions: [session], status: "landed" },
    true,
    "human:ann",
    at,
  );
  assert.deepEqual(
    Array.map(gated, (event) => [event.status, event.actor]),
    [
      ["running", "orchestrator"],
      ["blocked_on_human", "orchestrator"],
      ["done", "human:ann"],
    ],
  );
  assert.deepEqual(
    Array.map(gated, (event) => [event.model, event.reasoning]),
    [
      ["sonnet", "low"],
      [undefined, undefined],
      [undefined, undefined],
    ],
  );
  assert.ok(Array.every(gated, (event) => event.ts === "2026-11-24T17:56:11.000Z"));
});

await test("eventsOf leaves the model off the running event of a task with no session", () => {
  const [running] = eventsOf(
    { id, model: "sonnet", reasoning: "low", sessions: [], status: "done" },
    false,
    "human:ann",
    at,
  );
  assert.equal(running?.model, undefined);
  assert.equal(running?.reasoning, undefined);
});

await test("eventsOf gives a pending task no events, and a running one only running", () => {
  const task = { id, model: "sonnet", reasoning: "low", sessions: [session] } as const;
  assert.deepEqual(eventsOf({ ...task, status: "pending" }, false, "human:ann", at), []);
  assert.deepEqual(
    Array.map(eventsOf({ ...task, status: "running" }, true, "human:ann", at), (e) => e.status),
    ["running"],
  );
  assert.deepEqual(
    Array.map(eventsOf({ ...task, status: "failed" }, false, "human:ann", at), (e) => e.status),
    ["running", "failed"],
  );
  assert.deepEqual(
    Array.map(
      eventsOf({ ...task, status: "blocked_on_human" }, true, "human:ann", at),
      (e) => e.status,
    ),
    ["running", "blocked_on_human"],
  );
});

await test("latest picks the newest time and falls back when there is none", () => {
  const later = DateTime.add(at, { hours: 1 });
  assert.equal(DateTime.Equivalence(latest([later, at], at), later), true);
  assert.equal(DateTime.Equivalence(latest([], at), at), true);
});

await test("firstDifference names the first line that differs, or none for equal texts", () => {
  assert.ok(Option.isNone(firstDifference("a\nb\n", "a\nb\n")));
  assert.deepEqual(
    firstDifference("a\nb\nc", "a\nx\nc"),
    Option.some('line 2: committed "b", generated "x"'),
  );
  assert.deepEqual(
    firstDifference("a", "a\nb"),
    Option.some('line 2: committed "(end of file)", generated "b"'),
  );
});

const manifest = Schema.decodeSync(Schema.fromJsonString(Manifest))(
  readFileSync(new URL("../../.cairn/manifest.json", import.meta.url), "utf8"),
);
const decodeEvents = Schema.decodeUnknownSync(Schema.Array(Event));
const statuses: ReadonlyArray<TaskStatus> = [
  "pending",
  "running",
  "blocked_on_human",
  "failed",
  "done",
  "landed",
];

await test("every status the manifest records survives eventsOf and derive, gated or not", () => {
  const template = Array.headNonEmpty(manifest.tasks);
  Array.forEach([false, true], (gated) =>
    Array.forEach(statuses, (status) => {
      // Only a gated task can wait on a human; the derivation reads an ungated one as done.
      if (status === "blocked_on_human" && !gated) return;
      const task = { ...template, files: [], humanGate: { required: gated, reasons: [] }, status };
      const events = eventsOf(task, gated, "human:ann", at);
      // A landed task is one the base branch reaches: the derivation lands it from a commit.
      const commit = {
        branch: null,
        files: [],
        onBase: true,
        parents: [],
        sections: [],
        session: null,
        sha: String.repeat(40)("a"),
        subject: "build it",
        taskId: task.id,
      };
      const derived = derive(
        { ...manifest, tasks: [task] },
        [],
        defaultConfig,
        decodeEvents(events),
        status === "landed" ? [Schema.decodeSync(GitCommit)(commit)] : [],
      );
      assert.deepEqual(
        Array.map(derived.tasks, (each) => each.status),
        [status],
        `${status}, gated ${gated}`,
      );
      assert.deepEqual(derived.warnings, [], `${status}, gated ${gated}`);
    }),
  );
});
