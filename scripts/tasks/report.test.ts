import assert from "node:assert/strict";
import { test } from "node:test";

import { Manifest, SpecIndex } from "@cairn/contract";
import { Array, DateTime, Option, Record, Schema, String } from "effect";

import {
  age,
  classify,
  type Evidence,
  isOpen,
  parseWorktrees,
  type Pull,
  renderOverview,
  renderTask,
  sectionRange,
  taskIds,
  Thread,
  threadTasks,
  trailerTasks,
} from "./report.ts";

const NOW = DateTime.makeUnsafe("2026-11-24T12:00:00.000Z");
const decodeManifest = Schema.decodeUnknownSync(Manifest);
const decodeThread = Schema.decodeUnknownSync(Thread);
const decodeIndex = Schema.decodeUnknownSync(SpecIndex);

// The branch of a one-digit task id: t3 is on demo/03-work.
const branchOf = (id: string) => `demo/0${String.slice(1)(id)}-work`;

// A manifest task as the file holds it, before decoding.
const task = (id: string, dependsOn: string[] = [], extra: { [key: string]: unknown } = {}) => ({
  branch: branchOf(id),
  commits: [],
  dependsOn,
  files: [`src/${id}.ts`],
  humanGate: { reasons: [], required: false },
  id,
  model: "sonnet",
  parent: null,
  prdSections: ["prd.demo"],
  reasoning: "low",
  sessions: [],
  specSections: ["spec.demo"],
  status: "pending",
  title: `Build ${id}`,
  worktree: null,
  ...extra,
});

const manifestOf = (...tasks: ReturnType<typeof task>[]) =>
  decodeManifest({ baseBranch: "main", feature: "demo", tasks, version: 1 });

const thread = (text: string, labels: { [key: string]: string } = {}, last?: string) =>
  decodeThread({
    message: { text, labels, createdAt: "2026-11-24T11:00:00.000Z" },
    last: Option.getOrNull(
      Option.map(Option.fromUndefinedOr(last), (reply) => ({
        text: reply,
        createdAt: "2026-11-24T11:30:00.000Z",
      })),
    ),
  });

const pull = (number: number, id: string): Pull => ({
  number,
  headRefName: branchOf(id),
  headRefOid: `oid-${number}`,
});

const evidence = (extra: Partial<Evidence> = {}): Evidence => ({
  trailers: [],
  merged: [],
  open: [],
  worktrees: [],
  threads: [],
  now: NOW,
  ...extra,
});

const states = (manifest: Manifest, given: Evidence) =>
  Record.fromEntries(
    Array.map(classify(manifest, given), (row) => [row.task.id as string, row.state] as const),
  );

await test("taskIds reads single ids, ranges with either dash and ids joined by a slash", () => {
  assert.deepEqual(taskIds("Starting the reader stack (t82-t85), then t31/t32 and t9–11"), [
    "t82",
    "t83",
    "t84",
    "t85",
    "t31",
    "t32",
    "t9",
    "t10",
    "t11",
  ]);
});

await test("taskIds ignores worktree names, repeats and a range that runs backwards or too far", () => {
  assert.deepEqual(taskIds("in cairn-wt-31 and wt-28: t5, t5 again"), ["t5"]);
  assert.deepEqual(taskIds("t9-t3"), ["t9"]);
  assert.deepEqual(taskIds("t1-t500"), ["t1"]);
});

await test("trailerTasks reads Cairn-Task lines wherever they sit in a commit message", () => {
  const log =
    "Add a thing\n\nCairn-Task: t6\nCairn-Section: spec.demo\n\nCo-Authored-By: x\n\nOther\n\nCairn-Task:t9\nSee Cairn-Task: t1 above\n";
  assert.deepEqual(trailerTasks(log), ["t6", "t9"]);
});

await test("parseWorktrees keeps the worktrees that have a branch", () => {
  const porcelain =
    "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo-wt-1\nHEAD def\nbranch refs/heads/demo/02-work\n\nworktree /repo-wt-2\nHEAD 123\ndetached\n";
  assert.deepEqual(parseWorktrees(porcelain), [
    { path: "/repo", branch: "main" },
    { path: "/repo-wt-1", branch: "demo/02-work" },
  ]);
});

await test("threadTasks prefers the tasks label, then the task label with the ids in the text", () => {
  assert.deepEqual(threadTasks(thread("Starting t1 and t2", { task: "t7" })), ["t7", "t1", "t2"]);
  assert.deepEqual(threadTasks(thread("Starting t1; t9 waits", { task: "t1", tasks: "t1-t3" })), [
    "t1",
    "t2",
    "t3",
  ]);
});

await test("a thread is open until its latest reply says the work stopped or landed", () => {
  assert.equal(isOpen(thread("Starting t1")), true);
  assert.equal(isOpen(thread("Starting t1", {}, "PR open: https://example.test/1")), true);
  assert.equal(isOpen(thread("Starting t1", {}, "PR open. Stopping here.")), false);
  assert.equal(isOpen(thread("Starting t1", {}, "Landed: abc1234")), false);
});

const ago = (iso: string) => age(DateTime.makeUnsafe(iso), NOW);

await test("age is in minutes, then hours, then days", () => {
  assert.deepEqual(
    [
      ago("2026-11-24T11:57:10.000Z"),
      ago("2026-11-24T02:00:00.000Z"),
      ago("2026-11-21T12:00:00.000Z"),
    ],
    ["2m", "10h", "3d"],
  );
});

await test("classify: done and landed are finished, a pending task with nothing unfinished below it is ready, the rest are blocked", () => {
  const manifest = manifestOf(
    task("t1", [], { status: "done" }),
    task("t2", [], { status: "landed" }),
    task("t3", ["t1", "t2"]),
    task("t4", ["t3"]),
    task("t5", ["t4", "t1"]),
  );
  const rows = classify(manifest, evidence());
  assert.deepEqual(states(manifest, evidence()), {
    t1: "finished",
    t2: "finished",
    t3: "ready",
    t4: "blocked",
    t5: "blocked",
  });
  assert.deepEqual(
    Array.map(rows, (row) => row.waitsOn),
    [[], [], [], ["t3"], ["t4"]],
  );
});

await test("classify: a pending task on main is drifted, by a trailer or by a merged pull request, and no longer blocks", () => {
  const manifest = manifestOf(task("t1"), task("t2"), task("t3", ["t1", "t2"]), task("t4"));
  const given = evidence({ trailers: ["t1"], merged: [pull(7, "t2")] });
  const rows = classify(manifest, given);
  assert.deepEqual(states(manifest, given), {
    t1: "drifted",
    t2: "drifted",
    t3: "ready",
    t4: "ready",
  });
  assert.deepEqual(
    Array.map(rows, (row) => row.evidence),
    [["Cairn-Task trailer on main"], ["#7 merged"], [], []],
  );
});

await test("classify: an open pull request, a worktree or an open board thread claims a pending task", () => {
  const manifest = manifestOf(task("t1"), task("t2"), task("t3"), task("t4"), task("t5", ["t1"]));
  const given = evidence({
    open: [pull(8, "t1")],
    worktrees: [
      { path: "/home/me/repo-wt-2", branch: branchOf("t2") },
      { path: "/home/me/repo", branch: "main" },
    ],
    threads: [
      thread("Starting t3 and t5"),
      thread("Starting t4", { task: "t4" }, "Stopping: blocked on review"),
    ],
  });
  const rows = classify(manifest, given);
  assert.deepEqual(states(manifest, given), {
    t1: "claimed",
    t2: "claimed",
    t3: "claimed",
    t4: "ready",
    t5: "claimed",
  });
  assert.deepEqual(
    Array.map(rows, (row) => row.evidence),
    [["PR #8"], ["worktree repo-wt-2"], ["board 1h ago"], [], ["board 1h ago"]],
  );
});

await test("classify: a status other than pending is active whatever claims it, and a finished task ignores claims", () => {
  const manifest = manifestOf(
    task("t1", [], { status: "running" }),
    task("t2", [], { status: "blocked_on_human" }),
    task("t3", [], { status: "failed" }),
    task("t4", [], { status: "done" }),
  );
  const given = evidence({ open: [pull(1, "t1"), pull(4, "t4")], trailers: ["t4"] });
  assert.deepEqual(states(manifest, given), {
    t1: "active",
    t2: "active",
    t3: "active",
    t4: "finished",
  });
});

await test("classify: unlocks counts the unfinished tasks above, each once, and survives a dependency loop", () => {
  // t1 <- t2 <- t4, t1 <- t3 <- t4, t4 <- t5 (done); t6 and t7 depend on each other.
  const manifest = manifestOf(
    task("t1"),
    task("t2", ["t1"]),
    task("t3", ["t1"]),
    task("t4", ["t2", "t3"]),
    task("t5", ["t4"], { status: "done" }),
    task("t6", ["t7"]),
    task("t7", ["t6"]),
  );
  assert.deepEqual(
    Array.map(classify(manifest, evidence()), (row) => row.unlocks),
    [3, 1, 1, 0, 0, 2, 2],
  );
});

await test("renderOverview groups the unfinished tasks, puts the most unlocking ready task first and hides threads with nothing unfinished", () => {
  const manifest = manifestOf(
    task("t1", [], { status: "done" }),
    task("t2"),
    task("t3", [], { humanGate: { reasons: ["tag:human"], required: true } }),
    task("t4", ["t3"]),
    task("t5"),
    task("t6"),
  );
  const given = evidence({
    trailers: ["t6"],
    threads: [
      thread("Starting t5", { branch: branchOf("t5") }),
      thread("Starting t1"),
      thread("Opening the channel"),
    ],
  });
  const out = renderOverview(manifest, classify(manifest, given), given);
  assert.equal(
    Array.headNonEmpty(String.split(out, "\n")),
    "demo: 6 tasks: 1 finished, 1 drifted, 1 claimed, 2 ready, 1 blocked",
  );
  assert.match(out, /Drifted[^\n]*\n  t6 .*Cairn-Task trailer on main; manifest says pending/u);
  assert.match(out, /Claimed\n  t5 .*Build t5 \(board 1h ago\)/u);
  assert.match(
    out,
    /Ready[^\n]*\n  t3 .*GATE Build t3 \(unlocks 1\)\n  t2 .*Build t2 \(unlocks 0\)/u,
  );
  assert.match(out, /Blocked\n  t4 .*\(waits on t3\)/u);
  assert.match(out, /\n  1h   demo\/05-work: Starting t5\n/u);
  assert.doesNotMatch(out, /Starting t1|Opening the channel|Active/u);
});

const section = (id: string, level: number, line: number) => ({
  artifacts: [],
  children: [],
  context: [],
  decisions: [],
  defers: [],
  dependsOn: [],
  files: [],
  human: false,
  id,
  implements: [],
  level,
  line,
  parent: null,
  requirements: [],
  summary: `About ${id}.`,
  tasks: [],
  tests: [],
  title: id,
});

const index = decodeIndex({
  manifest: ".cairn/manifest.json",
  prd: ".cairn/prd.md",
  source: ".cairn/spec.md",
  version: 1,
  sections: [
    section("spec.a", 1, 1),
    section("spec.demo", 2, 10),
    section("spec.demo.inner", 3, 20),
    section("spec.next", 2, 30),
    section("spec.last", 1, 40),
  ],
});

const end = (id: string) => Option.map(sectionRange(index.sections, id, 55), (range) => range.end);

await test("sectionRange ends a section before the next one at its level or above, or at the last line", () => {
  assert.deepEqual(
    Array.map(
      ["spec.a", "spec.demo", "spec.demo.inner", "spec.next", "spec.last", "spec.missing"],
      end,
    ),
    [
      Option.some(39),
      Option.some(29),
      Option.some(29),
      Option.some(39),
      Option.some(55),
      Option.none(),
    ],
  );
});

await test("renderTask shows what a task waits on, what waits on it, its files and its spec lines", () => {
  const manifest = manifestOf(
    task("t1", [], { status: "done" }),
    task("t2"),
    task("t3", ["t1", "t2", "t8"], { specSections: ["spec.demo", "spec.gone"] }),
    task("t4", ["t3"]),
  );
  const rows = classify(manifest, evidence());
  const out = renderTask(
    Option.getOrThrow(Array.findFirst(rows, (row) => row.task.id === "t3")),
    rows,
    index,
    55,
  );
  assert.match(out, /^t3 {2}Build t3\n {2}state {5}blocked: waits on t2, t8\n/u);
  assert.match(out, /depends {3}t1 \(finished\), t2 \(ready\), t8 \(not in the manifest\)/u);
  assert.match(out, /unlocks {3}t4 \(blocked\)/u);
  assert.match(out, /files\n {4}src\/t3\.ts/u);
  assert.match(out, /\.cairn\/spec\.md:10-29 {2}spec\.demo {2}About spec\.demo\./u);
  assert.match(out, /spec\.gone \(not in \.cairn\/spec\.md\)/u);
});
