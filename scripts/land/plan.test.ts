import assert from "node:assert/strict";
import { test } from "node:test";

import { Array, Option, Record, Result } from "effect";

import {
  blockers,
  chainBreak,
  checkSummary,
  links,
  mergeBlocker,
  orderStack,
  type PullRequest,
  REQUIRED_CHECK,
} from "./plan.ts";

const pull = (
  number: number,
  headRefName: string,
  baseRefName: string,
  extra: Partial<PullRequest> = {},
): PullRequest => ({
  number,
  title: `pull ${number}`,
  headRefName,
  baseRefName,
  headRefOid: `oid-${number}`,
  isCrossRepository: false,
  isDraft: false,
  reviewDecision: "",
  labels: [{ name: "reviewed" }],
  mergeable: "MERGEABLE",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  ...extra,
});

const numbers = (stack: readonly PullRequest[]) => Array.map(stack, (p) => p.number);

await test("orderStack follows base branches from the top down to the trunk, bottom first", () => {
  const pulls = [
    pull(3, "c", "b"),
    pull(9, "other", "main"),
    pull(1, "a", "main"),
    pull(2, "b", "a"),
  ];
  const ordered = orderStack(pulls, "c", "main");
  assert.ok(Result.isSuccess(ordered));
  assert.deepEqual(numbers(ordered.success), [1, 2, 3]);
});

const reason = (pulls: PullRequest[], top: string) => {
  const ordered = orderStack(pulls, top, "main");
  assert.ok(Result.isFailure(ordered));
  return ordered.failure;
};

await test("orderStack stops at a missing link instead of landing part of a stack", () => {
  assert.match(reason([pull(3, "c", "b")], "c"), /#3 targets b/);
  assert.match(reason([], "c"), /c has no open pull request/);
  assert.match(reason([pull(1, "a", "b"), pull(2, "b", "a")], "a"), /loop/);
  assert.match(reason([], "main"), /is the trunk/);
});

await test("orderStack ignores a fork whose branch has the same name", () => {
  assert.ok(
    Result.isFailure(orderStack([pull(7, "a", "main", { isCrossRepository: true })], "a", "main")),
  );
});

await test("a reviewed, mergeable pull request with passing checks has no blockers", () => {
  assert.deepEqual(blockers(pull(1, "a", "main")), []);
  assert.deepEqual(blockers(pull(1, "a", "main", { labels: [], reviewDecision: "APPROVED" })), []);
});

const blocks = (extra: Partial<PullRequest>, pattern: RegExp) =>
  assert.match(Array.join(blockers(pull(1, "a", "main", extra)), "; "), pattern);

await test("each unmet requirement blocks the pull request", () => {
  blocks({ isDraft: true }, /draft/);
  blocks({ labels: [] }, /not approved/);
  blocks({ labels: [{ name: "bug" }], reviewDecision: "CHANGES_REQUESTED" }, /not approved/);
  blocks({ mergeable: "UNKNOWN" }, /mergeable state is UNKNOWN/);
  blocks({ mergeable: "CONFLICTING" }, /CONFLICTING/);
  blocks({ statusCheckRollup: [] }, /CI has not run "check"/);
  blocks({ statusCheckRollup: null }, /CI has not run "check"/);
  // Another passing check does not stand in for CI's.
  blocks(
    { statusCheckRollup: [{ __typename: "StatusContext", context: "deploy", state: "SUCCESS" }] },
    /CI has not run "check"/,
  );
  blocks(
    {
      statusCheckRollup: [
        { __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "FAILURE" },
      ],
    },
    /failed checks: check/,
  );
  blocks(
    {
      statusCheckRollup: [
        { __typename: "CheckRun", name: "check", status: "IN_PROGRESS", conclusion: "" },
      ],
    },
    /pending checks: check/,
  );
  blocks(
    { statusCheckRollup: [{ __typename: "StatusContext", context: "deploy", state: "ERROR" }] },
    /failed checks: deploy/,
  );
  blocks(
    { statusCheckRollup: [{ __typename: "StatusContext", context: "deploy", state: "PENDING" }] },
    /pending checks: deploy/,
  );
});

await test("a stack whose middle pull request failed CI is blocked though its top passed", () => {
  // The local gate passed at the top, which says nothing about the commits below it on their own.
  const failed = {
    statusCheckRollup: [
      {
        __typename: "CheckRun" as const,
        name: REQUIRED_CHECK,
        status: "COMPLETED",
        conclusion: "FAILURE",
      },
    ],
  };
  const ordered = orderStack(
    [pull(1, "a", "main"), pull(2, "b", "a", failed), pull(3, "c", "b")],
    "c",
    "main",
  );
  assert.ok(Result.isSuccess(ordered));
  const blocked = Array.map(ordered.success, (p) => [p.number, blockers(p)] as const);
  assert.deepEqual(blocked, [
    [1, []],
    [2, ["failed checks: check"]],
    [3, []],
  ]);
});

await test("checkSummary counts skipped and neutral runs and successful statuses as passed", () => {
  const summary = checkSummary({
    statusCheckRollup: [
      { __typename: "CheckRun", name: "a", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "NEUTRAL" },
      { __typename: "StatusContext", context: "c", state: "SUCCESS" },
    ],
  });
  assert.deepEqual(summary, { passed: ["a", "b", "c"], pending: [], failed: [] });
});

await test("links pairs each head with the trunk or the head below it", () => {
  const stack = [pull(1, "a", "main"), pull(2, "b", "a")];
  assert.deepEqual(links(stack, "trunk"), [
    ["trunk", "oid-1"],
    ["oid-1", "oid-2"],
  ]);
});

// The number of the pull request chainBreak names, asking `isAncestor` what land.ts asks git.
const broken = (
  pulls: readonly PullRequest[],
  trunk: string,
  isAncestor: (a: string, b: string) => boolean,
) =>
  Option.map(
    chainBreak(
      pulls,
      trunk,
      Array.map(links(pulls, trunk), ([a, b]) => isAncestor(a, b)),
    ),
    (p) => p.number,
  );

await test("chainBreak names the first pull request that is not a straight line from the trunk", () => {
  const stack = [pull(1, "a", "main"), pull(2, "b", "a"), pull(3, "c", "b")];
  const rank = Record.fromEntries(
    Array.map(["trunk", "oid-1", "oid-2", "oid-3"], (oid, i) => [oid, i] as const),
  );
  const linear = (a: string, b: string) =>
    Option.match(Option.all([Record.get(rank, a), Record.get(rank, b)]), {
      onNone: () => false,
      onSome: ([ra, rb]) => ra < rb,
    });
  assert.deepEqual(broken(stack, "trunk", linear), Option.none());
  // The trunk moved: the bottom no longer sits on it.
  assert.deepEqual(broken(stack, "new-trunk", linear), Option.some(1));
  // The middle was rebased without the top.
  const staleTop = (a: string, b: string) =>
    a === "oid-2" && b === "oid-3" ? false : linear(a, b);
  assert.deepEqual(broken(stack, "trunk", staleTop), Option.some(3));
  // A pull request with no commits of its own has nothing to land, though git counts a commit as its own ancestor.
  const reflexive = (a: string, b: string) => a === b || linear(a, b);
  assert.deepEqual(
    broken([pull(1, "a", "main", { headRefOid: "trunk" })], "trunk", reflexive),
    Option.some(1),
  );
});

await test("mergeBlocker refuses a pull request whose commits include a merge, naming the first one", () => {
  assert.ok(Option.isNone(mergeBlocker([])));
  assert.match(
    Option.getOrThrow(mergeBlocker(["d3bb427 Merge commit 'd181060' into HEAD"])),
    /has 1 merge commit \(d3bb427 Merge commit 'd181060' into HEAD\); rebase/,
  );
  assert.match(
    Option.getOrThrow(mergeBlocker(["aaa Merge a", "bbb Merge b"])),
    /has 2 merge commits \(aaa Merge a, \.\.\.\)/,
  );
});
