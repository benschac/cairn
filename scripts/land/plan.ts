// Pure planning for scripts/land/land.ts: order a stack of pull requests and decide whether it may land.
// A pull request here is one item of `gh pr list --json`.

import { Array, Option, pipe, Record, Schema } from "effect";

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

export const PULL_FIELDS = Array.join(Record.keys(PullRequest.fields), ",");

export type Ordered =
  | { readonly ok: true; readonly stack: readonly [PullRequest, ...PullRequest[]] }
  | { readonly ok: false; readonly reason: string };

// The open pull requests from the trunk up to `top`, bottom first, found by following base branches.
export const orderStack = (pulls: readonly PullRequest[], top: string, trunk: string): Ordered => {
  const byHead = Record.fromEntries(
    Array.map(
      Array.filter(pulls, (pull) => !pull.isCrossRepository),
      (pull) => [pull.headRefName, pull] as const,
    ),
  );
  // Walks down from `branch`, holding the pull requests above it bottom first.
  const walk = (branch: string, above: readonly PullRequest[]): Ordered => {
    if (branch === trunk) {
      return Array.match(above, {
        onEmpty: (): Ordered => ({ ok: false, reason: `${top} is the trunk` }),
        onNonEmpty: (stack): Ordered => ({ ok: true, stack }),
      });
    }
    return Option.match(Record.get(byHead, branch), {
      onNone: (): Ordered => ({
        ok: false,
        reason: Option.match(Array.head(above), {
          onNone: () => `${branch} has no open pull request`,
          onSome: (bottom) =>
            `#${bottom.number} targets ${branch}, which is not ${trunk} and has no open pull request`,
        }),
      }),
      onSome: (pull) =>
        Array.some(above, (seen) => seen === pull)
          ? { ok: false, reason: `the base branches loop at #${pull.number}` }
          : walk(pull.baseRefName, Array.prepend(above, pull)),
    });
  };
  return walk(top, []);
};

export interface CheckSummary {
  readonly passed: string[];
  readonly pending: string[];
  readonly failed: string[];
}

const PASSED: ReadonlyArray<string> = ["SUCCESS", "NEUTRAL", "SKIPPED"];

// Sorts a pull request's checks into passed, pending and failed names.
export const checkSummary = (pull: Pick<PullRequest, "statusCheckRollup">): CheckSummary => {
  const sorted = Array.map(pull.statusCheckRollup ?? [], (check) => {
    const [name, done, outcome] =
      "name" in check
        ? [check.name, check.status === "COMPLETED", check.conclusion]
        : [check.context, check.state !== "PENDING" && check.state !== "EXPECTED", check.state];
    const state: keyof CheckSummary = !done
      ? "pending"
      : Array.contains(PASSED, outcome)
        ? "passed"
        : "failed";
    return { name, state };
  });
  const named = (state: keyof CheckSummary) =>
    Array.map(
      Array.filter(sorted, (check) => check.state === state),
      (check) => check.name,
    );
  return { passed: named("passed"), pending: named("pending"), failed: named("failed") };
};

// Every reason a pull request may not land; an empty list means it may.
export const blockers = (pull: PullRequest): string[] => {
  const reasons: string[] = [];
  if (pull.isDraft) reasons.push("is a draft");
  const reviewed =
    pull.reviewDecision === "APPROVED" ||
    Array.some(pull.labels, (label) => label.name === REVIEWED_LABEL);
  if (!reviewed) reasons.push(`is not approved and has no "${REVIEWED_LABEL}" label`);
  // GitHub starts workflows only after it has computed the merge, so anything else can hide checks that have not started.
  if (pull.mergeable !== "MERGEABLE") reasons.push(`mergeable state is ${pull.mergeable}`);
  const checks = checkSummary(pull);
  if (Array.isReadonlyArrayNonEmpty(checks.failed)) {
    reasons.push(`failed checks: ${Array.join(checks.failed, ", ")}`);
  }
  if (Array.isReadonlyArrayNonEmpty(checks.pending)) {
    reasons.push(`pending checks: ${Array.join(checks.pending, ", ")}`);
  }
  if (
    Array.isReadonlyArrayEmpty(checks.failed) &&
    Array.isReadonlyArrayEmpty(checks.pending) &&
    Array.isReadonlyArrayEmpty(checks.passed)
  ) {
    reasons.push("has no checks");
  }
  return reasons;
};

// The commit each pull request sits on and its own head, bottom first: the trunk, then the head of the one below.
export const links = (
  stack: readonly PullRequest[],
  trunkOid: string,
): (readonly [below: string, head: string])[] => {
  const heads = Array.map(stack, (pull) => pull.headRefOid);
  return Array.zip(Array.prepend(heads, trunkOid), heads);
};

// The first pull request whose head does not sit on the one below it (the trunk for the bottom), or undefined
// when the whole stack is a straight line from the trunk. `isAncestor(a, b)` answers whether commit a is reachable from b.
export const chainBreak = (
  stack: readonly PullRequest[],
  trunkOid: string,
  isAncestor: (a: string, b: string) => boolean,
): PullRequest | undefined =>
  pipe(
    Array.zip(stack, links(stack, trunkOid)),
    Array.findFirst(([, [below, head]]) => head === below || !isAncestor(below, head)),
    Option.map(([pull]) => pull),
    Option.getOrUndefined,
  );

// Why a pull request whose own commits include merge commits may not land, or undefined when they are a straight line.
// Landing fast-forwards main, so every merge would show on main as "Merge commit ... into HEAD" in place of the
// commits themselves. `merges` lists the merge commits between the pull request below and this head, as "<sha> <subject>".
export const mergeBlocker = (merges: readonly string[]): string | undefined =>
  Array.match(merges, {
    onEmpty: () => undefined,
    onNonEmpty: ([first, ...rest]) => {
      const [count, more] = Array.isReadonlyArrayEmpty(rest)
        ? ["1 merge commit", ""]
        : [`${merges.length} merge commits`, ", ..."];
      return `has ${count} (${first}${more}); rebase it onto the pull request below instead of merging`;
    },
  });
