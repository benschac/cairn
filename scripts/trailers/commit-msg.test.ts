import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Manifest, type ManifestTask } from "@cairn/contract";
import { Array, Option, Record, Schema, String } from "effect";

import { refusal, trailerProblems, trailersToAdd } from "./check.ts";

const HOOK = join(import.meta.dirname, "commit-msg.ts");

const rawManifest = {
  baseBranch: "main",
  feature: "demo",
  tasks: [
    {
      branch: "demo/07-first",
      commits: [],
      dependsOn: [],
      files: [],
      humanGate: { reasons: [], required: false },
      id: "t7",
      model: "sonnet",
      parent: null,
      prdSections: ["prd.one"],
      reasoning: "medium",
      sessions: [],
      specSections: ["spec.one.a", "spec.one.b"],
      status: "pending",
      title: "First",
      worktree: null,
    },
  ],
  version: 1,
} as const;
const manifest = Schema.decodeSync(Manifest)(rawManifest);
const task: ManifestTask = manifest.tasks[0];

const message = (...trailers: Array<string>) =>
  Array.join(Array.prepend(trailers, "Add the first thing\n\nt7. Body.\n"), "\n");

await test("a message with the task and one of its sections passes, with or without a session", () => {
  const ok = message("Cairn-Task: t7", "Cairn-Section: spec.one.b");
  assert.deepEqual(trailerProblems(task, ok), []);
  assert.ok(Option.isNone(refusal(task, ok)));
  const withSession = message(
    "Cairn-Task: t7",
    "Cairn-Section: spec.one.a",
    "Cairn-Section: spec.one.b",
    "Cairn-Session: s_abc123",
  );
  assert.deepEqual(trailerProblems(task, withSession), []);
});

const problemsOf = (text: string) => trailerProblems(task, text);

await test("each way a message can lack its trailers is named", () => {
  assert.deepEqual(problemsOf(message()), ["no Cairn-Task trailer", "no Cairn-Section trailer"]);
  assert.deepEqual(problemsOf(message("Cairn-Section: spec.one.a")), ["no Cairn-Task trailer"]);
  assert.deepEqual(problemsOf(message("Cairn-Task: t7")), ["no Cairn-Section trailer"]);
  assert.deepEqual(problemsOf(message("Cairn-Task: t8", "Cairn-Section: spec.one.a")), [
    "Cairn-Task names t8, not t7",
  ]);
  assert.deepEqual(
    problemsOf(message("Cairn-Task: t7", "Cairn-Task: t7", "Cairn-Section: spec.one.a")),
    ["more than one Cairn-Task trailer"],
  );
  assert.deepEqual(problemsOf(message("Cairn-Task: t7", "Cairn-Section: spec.two.z")), [
    "no Cairn-Section names a section of t7",
  ]);
});

await test("Cairn lines outside the last paragraph are not trailers, as git reads them", () => {
  const early = Array.join(
    [
      "Add it",
      "",
      "Cairn-Task: t7",
      "Cairn-Section: spec.one.a",
      "",
      "Co-authored-by: Someone <someone@example.com>",
    ],
    "\n",
  );
  assert.equal(problemsOf(early).length, 2);
  assert.equal(problemsOf("Cairn-Task: t7\nCairn-Section: spec.one.a").length, 2);
  const last = Array.join(
    [
      "Add it",
      "",
      "Cairn-Task: t7",
      "Cairn-Section: spec.one.a",
      "Co-authored-by: Someone <someone@example.com>",
    ],
    "\n",
  );
  assert.deepEqual(problemsOf(last), []);
});

await test("a comment line is not a trailer", () => {
  const commented = message("# Cairn-Task: t7", "# Cairn-Section: spec.one.a");
  assert.equal(trailerProblems(task, commented).length, 2);
});

await test("the refusal prints the exact trailer lines to add", () => {
  assert.equal(
    trailersToAdd(task),
    "Cairn-Task: t7\nCairn-Section: spec.one.a\nCairn-Section: spec.one.b",
  );
  const text = Option.getOrThrow(refusal(task, message()));
  assert.ok(String.includes(trailersToAdd(task))(text));
});

// A throwaway repository on a task's branch, to run the hook the way lefthook does.
const repo = mkdtempSync(join(tmpdir(), "cairn-trailers-"));
// Git sets GIT_DIR and friends inside a hook; the throwaway repository must not see them.
const env = Record.filter(process.env, (_, key) => !String.startsWith("GIT_")(key));
const run = (command: string, args: Array<string>) =>
  spawnSync(command, args, { cwd: repo, env, encoding: "utf8" });
const git = (...args: Array<string>) => {
  const result = run("git", args);
  assert.equal(result.status, 0, `git ${Array.join(args, " ")}: ${result.stderr}`);
  return String.trim(result.stdout);
};
const hook = (text: string) => {
  const file = join(repo, "MSG");
  writeFileSync(file, text);
  return run("node", [HOOK, file]);
};

git("init", "-q", "-b", "demo/07-first");
git("config", "user.name", "trailers test");
git("config", "user.email", "trailers@example.invalid");
git("config", "commit.gpgsign", "false");
mkdirSync(join(repo, ".cairn"));
writeFileSync(join(repo, ".cairn/manifest.json"), JSON.stringify(rawManifest));
git("add", "-A");
git("commit", "-q", "-m", "first");

await test("on a task's branch the hook refuses a message without its trailers and says what to add", () => {
  const refused = hook(message());
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Cairn-Task: t7/);
  assert.match(refused.stderr, /Cairn-Section: spec\.one\.a/);
  const accepted = hook(message("Cairn-Task: t7", "Cairn-Section: spec.one.a"));
  assert.equal(accepted.status, 0, accepted.stderr);
});

await test("on any other branch, or with none checked out, the hook passes", () => {
  git("checkout", "-q", "-b", "side");
  assert.equal(hook(message()).status, 0);
  git("checkout", "-q", "--detach", "demo/07-first");
  const detached = hook(message());
  assert.equal(detached.status, 0, detached.stderr);
});

rmSync(repo, { recursive: true, force: true });
