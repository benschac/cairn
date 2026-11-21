import assert from "node:assert/strict";
import { test } from "node:test";

import { skipsCommitHook } from "./policy.ts";

const refused = [
  "git commit -n",
  "git commit -n -m 'skip'",
  "git commit -nm skip",
  "git commit -anm skip",
  "git commit --no-verify -m skip",
  "git commit --no-veri -m skip",
  "git commit -m skip --no-verify",
  "git -C packages/core commit -n",
  "git add . && git commit -n -m skip",
  "cd packages/core; git commit --no-verify",
  "git push --no-verify",
  "LEFTHOOK=0 git commit -m skip",
  "env LEFTHOOK=false git commit -m skip",
  "export LEFTHOOK=0",
  "LEFTHOOK_EXCLUDE=check git commit -m skip",
  "git -c core.hooksPath=/dev/null commit -m skip",
  "git config core.hooksPath /dev/null",
  "pnpm exec lefthook uninstall",
  "lefthook uninstall",
  "rm .git/hooks/pre-commit",
  "echo '' > .git/hooks/pre-commit",
  "chmod -x .git/hooks/pre-commit",
  'bash -c "git commit -n -m skip"',
  "sh -c 'git commit --no-verify'",
];

const allowed = [
  "git commit -m 'add the task machine'",
  "git commit -m 'explain why -n and --no-verify are refused'",
  "git commit -am fix",
  "git commit -F message.txt",
  "git commit --amend --no-edit",
  "git log -n 5",
  "git config --get core.hooksPath",
  "cat .git/hooks/pre-commit",
  "pnpm exec lefthook install",
  "pnpm check",
  "grep -rn no-verify scripts",
];

await test("refuses every command that skips the hook", () => {
  for (const command of refused) {
    assert.equal(skipsCommitHook(command), true, command);
  }
});

await test("allows commands that leave the hook alone", () => {
  for (const command of allowed) {
    assert.equal(skipsCommitHook(command), false, command);
  }
});
