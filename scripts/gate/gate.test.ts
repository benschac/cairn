import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Array, pipe, Predicate, Record, Schema, String } from "effect";

import {
  appendRecord,
  pushedCommits,
  RECORD_FILE,
  RECORD_LIMIT,
  recordedCommits,
} from "./checked.ts";
import { Holder, LOCK_FILE } from "./lock.ts";

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
// stack: bottom passes, middle fails, top passes. With CHECK_LOG set, the check writes a line to that file when it
// starts and when it ends; with CHECK_HOLD set, it waits for that file to exist before it ends. Both live outside
// the repository, so the tree stays clean.
const repo = mkdtempSync(join(tmpdir(), "cairn-gate-"));
const outside = mkdtempSync(join(tmpdir(), "cairn-gate-files-"));
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
  Array.join(
    [
      'import { appendFileSync, existsSync } from "node:fs";',
      "const { CHECK_HOLD, CHECK_LOG, CHECK_NAME } = process.env;",
      "if (CHECK_LOG) appendFileSync(CHECK_LOG, `start ${CHECK_NAME}\\n`);",
      "while (CHECK_HOLD && !existsSync(CHECK_HOLD)) await new Promise((done) => setTimeout(done, 50));",
      "if (CHECK_LOG) appendFileSync(CHECK_LOG, `end ${CHECK_NAME}\\n`);",
      'process.exitCode = existsSync("broken") ? 1 : 0;',
      "",
    ],
    "\n",
  ),
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

await test("the record is replaced whole, not rewritten in place, and leaves no staging directory", () => {
  const record = join(repo, ".git", RECORD_FILE);
  const before = statSync(record);
  const passed = check();
  assert.equal(passed.status, 0, passed.stderr);
  const after = statSync(record);
  // A new file at the same path, so a reader holds the old record or the new, never a half-written one.
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  assert.deepEqual(Array.filter(readdirSync(join(repo, ".git")), String.startsWith(".write-")), []);
  assert.equal(push(top).status, 0);
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

// THE CHECK LOCK

const lockFile = join(repo, ".git", LOCK_FILE);
const log = join(outside, "runs.log");
const hold = join(outside, "hold");
const runs = () =>
  existsSync(log)
    ? Array.filter(String.split(readFileSync(log, "utf8"), "\n"), String.isNonEmpty)
    : [];
const fresh = () => {
  rmSync(log, { force: true });
  rmSync(hold, { force: true });
};

/** Checks started by a test, ended when it finishes so a failed assertion leaves no check waiting. */
const started: Array<ReturnType<typeof spawn>> = [];
const endStarted = async () => {
  writeFileSync(hold, "");
  // Killing a check that already ended does nothing.
  Array.forEach(started, (child) => child.kill("SIGKILL"));
};

/** Starts a check without waiting for it: its process, its exit code, and its stderr so far. */
const startCheck = (name: string, vars: Record<string, string> = {}) => {
  const child = spawn("node", [GATE, "check"], {
    cwd: repo,
    env: Record.union(
      env,
      Record.union({ CHECK_LOG: log, CHECK_NAME: name }, vars, (_, set) => set),
      (_, set) => set,
    ),
  });
  started.push(child);
  const stderr: Array<string> = [];
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
  const exited = new Promise<number | null>((done) => child.on("exit", done));
  return { child, exited, stderr: () => Array.join(stderr, "") };
};

const ended = (child: ReturnType<typeof spawn>) =>
  Predicate.isNotNull(child.exitCode) || Predicate.isNotNull(child.signalCode);

/** Polls a child process's progress every 50 ms, for at most a minute. */
const until = async (
  what: string,
  condition: () => boolean,
  deadline = performance.now() + 60_000,
): Promise<void> => {
  if (condition()) return;
  assert.ok(performance.now() < deadline, `timed out waiting for ${what}`);
  await new Promise((done) => setTimeout(done, 50));
  return until(what, condition, deadline);
};

await test("a second check waits for the one running, says whose it is, and starts when it ends", async (t) => {
  t.after(endStarted);
  git("checkout", "-q", "main");
  fresh();
  const first = startCheck("first", { CHECK_HOLD: hold });
  await until("the first check to start", () => Array.contains(runs(), "start first"));
  const second = startCheck("second");
  await until("the second check to wait", () =>
    String.includes("Waiting for the pnpm check in")(second.stderr()),
  );
  assert.match(second.stderr(), new RegExp(`pid ${first.child.pid}`));
  assert.deepEqual(runs(), ["start first"]);
  writeFileSync(hold, "");
  assert.equal(await first.exited, 0, first.stderr());
  assert.equal(await second.exited, 0, second.stderr());
  assert.deepEqual(runs(), ["start first", "end first", "start second", "end second"]);
  assert.equal(existsSync(lockFile), false);
});

await test("a check that fails or is interrupted gives the lock back", async (t) => {
  t.after(endStarted);
  git("checkout", "-q", middle);
  assert.notEqual(check().status, 0);
  assert.equal(existsSync(lockFile), false);
  git("checkout", "-q", "main");
  fresh();
  const interrupted = startCheck("interrupted", { CHECK_HOLD: hold });
  await until("the check to start", () => Array.contains(runs(), "start interrupted"));
  assert.equal(existsSync(lockFile), true);
  interrupted.child.kill("SIGINT");
  await until("the interrupted check to end", () => ended(interrupted.child));
  assert.notEqual(interrupted.child.exitCode, 0);
  // Let the check's own process end too, if the interrupt left it waiting.
  writeFileSync(hold, "");
  assert.equal(existsSync(lockFile), false);
  const next = check();
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stderr, /Waiting/);
});

await test("a check waiting for the lock can be interrupted, and leaves the holder's lock alone", async (t) => {
  t.after(endStarted);
  fresh();
  const holder = startCheck("holder", { CHECK_HOLD: hold });
  await until("the holder to start", () => Array.contains(runs(), "start holder"));
  const waiting = startCheck("waiting");
  await until("the second check to wait", () => String.includes("Waiting for")(waiting.stderr()));
  waiting.child.kill("SIGINT");
  await until("the waiting check to end", () => ended(waiting.child));
  assert.notEqual(waiting.child.exitCode, 0);
  assert.equal(existsSync(lockFile), true);
  writeFileSync(hold, "");
  assert.equal(await holder.exited, 0, holder.stderr());
  assert.deepEqual(runs(), ["start holder", "end holder"]);
  assert.equal(existsSync(lockFile), false);
});

/** A lock as a check killed before it could give it back leaves it: its holder's process has exited. */
const leaveStaleLock = () => {
  const gone = spawnSync("node", ["-e", ""]).pid;
  const text = Schema.encodeSync(Schema.fromJsonString(Holder))({
    pid: gone,
    since: "2026-01-01T00:00:00.000Z",
    worktree: repo,
  });
  writeFileSync(lockFile, text);
  return { gone, text };
};
const guardFile = `${lockFile}.clearing`;

/** A check run to the end; one that would wait for a lock forever is killed after a minute. */
const checkWithin = () =>
  spawnSync("node", [GATE, "check"], {
    cwd: repo,
    encoding: "utf8",
    env,
    killSignal: "SIGKILL",
    timeout: 60_000,
  });

await test("a lock left by a check that was killed is cleared, and the next check runs", () => {
  const { gone } = leaveStaleLock();
  const next = checkWithin();
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stderr, new RegExp(`Cleared the check lock left by pid ${gone}`));
  assert.equal(existsSync(lockFile), false);
  assert.equal(existsSync(guardFile), false);
});

await test("one check at a time clears a stale lock: while another holds the guard, it waits", async (t) => {
  t.after(endStarted);
  fresh();
  const { text } = leaveStaleLock();
  writeFileSync(guardFile, "a check clearing the lock");
  const waiting = startCheck("after-guard");
  // Three looks at the lock: none may clear it while the guard is held.
  await new Promise((done) => setTimeout(done, 3_000));
  assert.equal(readFileSync(lockFile, "utf8"), text);
  assert.deepEqual(runs(), []);
  rmSync(guardFile);
  await until("the check to end", () => ended(waiting.child));
  assert.equal(waiting.child.exitCode, 0, waiting.stderr());
  assert.deepEqual(runs(), ["start after-guard", "end after-guard"]);
  assert.equal(existsSync(lockFile), false);
});

await test("a guard left by a check killed while clearing is removed once it is ten seconds old", () => {
  leaveStaleLock();
  writeFileSync(guardFile, "a check killed while clearing");
  const minuteAgo = new Date(Date.now() - 60_000);
  utimesSync(guardFile, minuteAgo, minuteAgo);
  const next = checkWithin();
  assert.equal(next.status, 0, next.stderr);
  assert.equal(existsSync(guardFile), false);
  assert.equal(existsSync(lockFile), false);
});

rmSync(repo, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
