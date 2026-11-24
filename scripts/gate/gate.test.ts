import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Array, pipe, Record, String } from "effect";

import { appendRecord, pushedCommits, RECORD_LIMIT, recordedCommits } from "./checked.ts";

const GATE = join(import.meta.dirname, "gate.ts");
const sha = String.repeat(40);
const ZERO = sha("0");

await test("pushedCommits reads the local sha of each pushed ref and drops deletions", () => {
  const input = Array.join(
    [
      `refs/heads/a ${sha("a")} refs/heads/a ${ZERO}`,
      `refs/heads/b ${sha("b")} refs/heads/b ${sha("c")}`,
      `(delete) ${ZERO} refs/heads/gone ${sha("d")}`,
      `refs/heads/a2 ${sha("a")} refs/heads/a2 ${ZERO}`,
      "",
    ],
    "\n",
  );
  assert.deepEqual(pushedCommits(input), [sha("a"), sha("b")]);
  assert.deepEqual(pushedCommits(""), []);
});

await test("appendRecord moves a commit to the end and keeps only the latest", () => {
  assert.equal(appendRecord("", "a"), "a\n");
  assert.equal(appendRecord("a\nb\n", "a"), "b\na\n");
  const full = Array.join(
    Array.makeBy(RECORD_LIMIT, (index) => `c${index}`),
    "\n",
  );
  // Latest first: the new commit, then every old one but the oldest, c0.
  assert.deepEqual(
    recordedCommits(appendRecord(full, "new")),
    Array.prepend(Array.reverse(Array.makeBy(RECORD_LIMIT - 1, (index) => `c${index + 1}`)), "new"),
  );
});

// A throwaway repository whose check fails while a file named "broken" is committed, holding a three-commit
// stack: bottom passes, middle fails, top passes.
const repo = mkdtempSync(join(tmpdir(), "cairn-gate-"));
// Git sets GIT_DIR and friends inside a hook; the throwaway repository must not see them.
const env = Record.filter(process.env, (_, key) => !String.startsWith("GIT_")(key));
const run = (command: string, args: string[], input = "") =>
  spawnSync(command, args, { cwd: repo, env, input, encoding: "utf8" });
const git = (...args: string[]) => {
  const result = run("git", args);
  assert.equal(result.status, 0, `git ${Array.join(args, " ")}: ${result.stderr}`);
  return String.trim(result.stdout);
};
const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};
const check = () => run("node", [GATE, "check"]);
const push = (...shas: string[]) =>
  run(
    "node",
    [GATE, "pre-push"],
    pipe(
      shas,
      Array.map((oid) => `refs/heads/x ${oid} refs/heads/x ${ZERO}\n`),
      Array.join(""),
    ),
  );

git("init", "-q", "-b", "main");
git("config", "user.name", "gate test");
git("config", "user.email", "gate@example.invalid");
git("config", "commit.gpgsign", "false");
writeFileSync(
  join(repo, "package.json"),
  '{ "private": true, "scripts": { "check:tasks": "node check.mjs" } }\n',
);
writeFileSync(
  join(repo, "check.mjs"),
  'import { existsSync } from "node:fs";\nprocess.exitCode = existsSync("broken") ? 1 : 0;\n',
);
const bottom = commit("bottom passes");
writeFileSync(join(repo, "broken"), "");
const middle = commit("middle fails");
rmSync(join(repo, "broken"));
const top = commit("top passes");

await test("nothing may be pushed before a check passes", () => {
  const refused = push(bottom);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Push refused/);
});

await test("a failing check records nothing", () => {
  git("checkout", "-q", middle);
  assert.notEqual(check().status, 0);
  assert.notEqual(push(middle).status, 0);
});

await test("a check that passes with uncommitted changes records nothing", () => {
  git("checkout", "-q", "main");
  writeFileSync(join(repo, "notes.txt"), "not committed");
  const passed = check();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stderr, /was not recorded/);
  assert.notEqual(push(top).status, 0);
  rmSync(join(repo, "notes.txt"));
});

await test("a check that passes at the top lets the whole stack push, failing middle included", () => {
  const passed = check();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stderr, /Recorded/);
  // The gate vouches for the top only: CI and pnpm land catch the middle (scripts/land/plan.test.ts).
  const pushed = push(bottom, middle, top);
  assert.equal(pushed.status, 0, pushed.stderr);
  // Deleting a remote branch sends no commit.
  assert.equal(push(ZERO).status, 0);
});

await test("a commit the checked top does not contain is refused, even beside covered ones", () => {
  git("checkout", "-q", "-b", "side", bottom);
  writeFileSync(join(repo, "side.txt"), "side");
  const side = commit("side branch");
  const refused = push(top, side);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp(String.takeLeft(side, 7)));
  assert.doesNotMatch(refused.stderr, new RegExp(String.takeLeft(top, 7)));
  // A commit on top of the checked one is new too.
  git("checkout", "-q", "main");
  writeFileSync(join(repo, "more.txt"), "more");
  assert.notEqual(push(commit("after the check")).status, 0);
});

rmSync(repo, { recursive: true, force: true });
