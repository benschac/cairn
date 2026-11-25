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

// A trailer block as `git interpret-trailers --parse` prints it.
const trailers = (...lines: Array<string>) => Array.join(lines, "\n");
// A whole commit message ending in a paragraph of these lines.
const message = (...lines: Array<string>) =>
  Array.join(Array.prepend(lines, "Add the first thing\n\nt7. Body.\n"), "\n");

await test("the task and one of its sections pass, with or without a session", () => {
  const ok = trailers("Cairn-Task: t7", "Cairn-Section: spec.one.b");
  assert.deepEqual(trailerProblems(task, ok), []);
  assert.ok(Option.isNone(refusal(task, ok)));
  const withSession = trailers(
    "Cairn-Task: t7",
    "Cairn-Section: spec.one.a",
    "Cairn-Section: spec.one.b",
    "Cairn-Session: s_abc123",
  );
  assert.deepEqual(trailerProblems(task, withSession), []);
});

const problemsOf = (text: string) => trailerProblems(task, text);

await test("each way the trailers can fall short is named", () => {
  assert.deepEqual(problemsOf(trailers()), ["no Cairn-Task trailer", "no Cairn-Section trailer"]);
  assert.deepEqual(problemsOf(trailers("Cairn-Section: spec.one.a")), ["no Cairn-Task trailer"]);
  assert.deepEqual(problemsOf(trailers("Cairn-Task: t7")), ["no Cairn-Section trailer"]);
  assert.deepEqual(problemsOf(trailers("Cairn-Task: t8", "Cairn-Section: spec.one.a")), [
    "Cairn-Task names t8, not t7",
  ]);
  assert.deepEqual(
    problemsOf(trailers("Cairn-Task: t7", "Cairn-Task: t7", "Cairn-Section: spec.one.a")),
    ["more than one Cairn-Task trailer"],
  );
  assert.deepEqual(problemsOf(trailers("Cairn-Task: t7", "Cairn-Section: spec.two.z")), [
    "no Cairn-Section names a section of t7",
  ]);
});

await test("the refusal prints the exact trailer lines to add", () => {
  assert.equal(
    trailersToAdd(task),
    "Cairn-Task: t7\nCairn-Section: spec.one.a\nCairn-Section: spec.one.b",
  );
  const text = Option.getOrThrow(refusal(task, trailers()));
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

await test("the hook counts only what git reads as trailers", () => {
  const refused = (text: string) => assert.notEqual(hook(text).status, 0, text);
  // Cairn lines in a paragraph above the trailer block.
  refused(
    "Add it\n\nCairn-Task: t7\nCairn-Section: spec.one.a\n\nCo-authored-by: Someone <someone@example.com>\n",
  );
  // Cairn lines straight under prose, with no blank line between.
  refused("Add it\n\nt7. Body.\nCairn-Task: t7\nCairn-Section: spec.one.a\n");
  // A message of one paragraph is all subject.
  refused("Cairn-Task: t7\nCairn-Section: spec.one.a\n");
  // Comment lines are dropped before git reads the message.
  refused(message("# Cairn-Task: t7", "# Cairn-Section: spec.one.a"));
  const trailerBlock =
    "Cairn-Task: t7\nCairn-Section: spec.one.a\nCo-authored-by: Someone <someone@example.com>\n";
  assert.equal(hook(`Add it\n\nt7. Body.\n\n${trailerBlock}`).status, 0);
  // `git commit -v` puts the staged diff under a scissors line; git reads trailers above it.
  const verbose = Array.join(
    [
      `Add it\n\nt7. Body.\n\n${trailerBlock}`,
      "# ------------------------ >8 ------------------------",
      "# Do not modify or remove the line above.",
      "diff --git a/x b/x",
      "+x",
      "",
      "Unrelated: line",
      "",
    ],
    "\n",
  );
  const accepted = hook(verbose);
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
