// Pure planning for scripts/land/land.ts: order a stack of pull requests and decide whether it may land.
// A pull request here is one item of `gh pr list --json`.

import { Schema } from "effect";

export const REVIEWED_LABEL = "reviewed";

// GitHub reports check runs and commit statuses in two shapes.
const CheckRun = Schema.Struct({
  __typename: Schema.Literal("CheckRun"),
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.String,
});
const StatusContext = Schema.Struct({
  __typename: Schema.Literal("StatusContext"),
  context: Schema.String,
  state: Schema.String,
});

// The fields of `gh pr list --json` that the plan reads.
export const PullRequest = Schema.Struct({
  number: Schema.Finite,
  title: Schema.String,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
  isDraft: Schema.Boolean,
  reviewDecision: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  mergeable: Schema.String,
  statusCheckRollup: Schema.NullOr(Schema.Array(Schema.Union([CheckRun, StatusContext]))),
});
export type PullRequest = typeof PullRequest.Type;

export const PULL_FIELDS = Object.keys(PullRequest.fields).join(",");

export type Ordered =
  | { readonly ok: true; readonly stack: readonly [PullRequest, ...PullRequest[]] }
  | { readonly ok: false; readonly reason: string };

// The open pull requests from the trunk up to `top`, bottom first, found by following base branches.
export const orderStack = (pulls: readonly PullRequest[], top: string, trunk: string): Ordered => {
  const byHead = new Map(
    pulls.filter((pull) => !pull.isCrossRepository).map((pull) => [pull.headRefName, pull]),
  );
  const stack: PullRequest[] = [];
  for (let branch = top; branch !== trunk;) {
    const pull = byHead.get(branch);
    if (!pull) {
      const bottom = stack[0];
      const reason = bottom
        ? `#${bottom.number} targets ${branch}, which is not ${trunk} and has no open pull request`
        : `${branch} has no open pull request`;
      return { ok: false, reason };
    }
    if (stack.includes(pull))
      return { ok: false, reason: `the base branches loop at #${pull.number}` };
    stack.unshift(pull);
    branch = pull.baseRefName;
  }
  const [first, ...rest] = stack;
  if (!first) return { ok: false, reason: `${top} is the trunk` };
  return { ok: true, stack: [first, ...rest] };
};

export interface CheckSummary {
  readonly passed: string[];
  readonly pending: string[];
  readonly failed: string[];
}

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

// Sorts a pull request's checks into passed, pending and failed names.
export const checkSummary = (pull: Pick<PullRequest, "statusCheckRollup">): CheckSummary => {
  const summary: CheckSummary = { passed: [], pending: [], failed: [] };
  for (const check of pull.statusCheckRollup ?? []) {
    const [name, done, outcome] =
      "name" in check
        ? [check.name, check.status === "COMPLETED", check.conclusion]
        : [check.context, check.state !== "PENDING" && check.state !== "EXPECTED", check.state];
    summary[!done ? "pending" : PASSED.has(outcome) ? "passed" : "failed"].push(name);
  }
  return summary;
};

// Every reason a pull request may not land; an empty list means it may.
export const blockers = (pull: PullRequest): string[] => {
  const reasons: string[] = [];
  if (pull.isDraft) reasons.push("is a draft");
  const reviewed =
    pull.reviewDecision === "APPROVED" ||
    pull.labels.some((label) => label.name === REVIEWED_LABEL);
  if (!reviewed) reasons.push(`is not approved and has no "${REVIEWED_LABEL}" label`);
  // GitHub starts workflows only after it has computed the merge, so anything else can hide checks that have not started.
  if (pull.mergeable !== "MERGEABLE") reasons.push(`mergeable state is ${pull.mergeable}`);
  const checks = checkSummary(pull);
  if (checks.failed.length) reasons.push(`failed checks: ${checks.failed.join(", ")}`);
  if (checks.pending.length) reasons.push(`pending checks: ${checks.pending.join(", ")}`);
  if (!checks.failed.length && !checks.pending.length && !checks.passed.length) {
    reasons.push("has no checks");
  }
  return reasons;
};

// The commit each pull request sits on and its own head, bottom first: the trunk, then the head of the one below.
export const links = (
  stack: readonly PullRequest[],
  trunkOid: string,
): (readonly [below: string, head: string])[] =>
  stack.map((pull, i) => [
    i === 0 ? trunkOid : (stack[i - 1]?.headRefOid ?? trunkOid),
    pull.headRefOid,
  ]);

// The first pull request whose head does not sit on the one below it (the trunk for the bottom), or undefined
// when the whole stack is a straight line from the trunk. `isAncestor(a, b)` answers whether commit a is reachable from b.
export const chainBreak = (
  stack: readonly PullRequest[],
  trunkOid: string,
  isAncestor: (a: string, b: string) => boolean,
): PullRequest | undefined => {
  let below = trunkOid;
  for (const pull of stack) {
    if (pull.headRefOid === below || !isAncestor(below, pull.headRefOid)) return pull;
    below = pull.headRefOid;
  }
  return undefined;
};

// Why a pull request whose own commits include merge commits may not land, or undefined when they are a straight line.
// Landing fast-forwards main, so every merge would show on main as "Merge commit ... into HEAD" in place of the
// commits themselves. `merges` lists the merge commits between the pull request below and this head, as "<sha> <subject>".
export const mergeBlocker = (merges: readonly string[]): string | undefined => {
  const [first] = merges;
  if (first === undefined) return undefined;
  const count = merges.length === 1 ? "1 merge commit" : `${merges.length} merge commits`;
  return `has ${count} (${first}${merges.length > 1 ? ", ..." : ""}); rebase it onto the pull request below instead of merging`;
};
