// Pure planning for scripts/land/land.ts: order a stack of pull requests and decide whether it may land.
// A pull request here is one item of `gh pr list --json`.

import { Array, Option, pipe, Record, Result, Schema } from "effect";

export const REVIEWED_LABEL = "reviewed";

// GitHub reports check runs and commit statuses in two shapes.
const Check = Schema.Union([
  Schema.Struct({
    __typename: Schema.Literal("CheckRun"),
    name: Schema.String,
    status: Schema.String,
    conclusion: Schema.String,
  }),
  Schema.Struct({
    __typename: Schema.Literal("StatusContext"),
    context: Schema.String,
    state: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("__typename"));

// The fields of `gh pr list --json` that the plan reads.
export const PullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
  isDraft: Schema.Boolean,
  reviewDecision: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  mergeable: Schema.String,
  statusCheckRollup: Schema.NullOr(Schema.Array(Check)),
});
export type PullRequest = typeof PullRequest.Type;

export const PULL_FIELDS = Array.join(Record.keys(PullRequest.fields), ",");

// The open pull requests from the trunk up to `top`, bottom first, found by following base branches.
export const orderStack = (
  pulls: ReadonlyArray<PullRequest>,
  top: string,
  trunk: string,
): Result.Result<Array.NonEmptyReadonlyArray<PullRequest>, string> => {
  const byHead = Record.fromEntries(
    Array.map(
      Array.filter(pulls, (pull) => !pull.isCrossRepository),
      (pull) => [pull.headRefName, pull] as const,
    ),
  );
  // Walks down from `branch`, holding the pull requests above it bottom first.
  const walk = (
    branch: string,
    above: ReadonlyArray<PullRequest>,
  ): Result.Result<Array.NonEmptyReadonlyArray<PullRequest>, string> => {
    if (branch === trunk) {
      return Array.match(above, {
        onEmpty: () => Result.fail(`${top} is the trunk`),
        onNonEmpty: Result.succeed,
      });
    }
    return Option.match(Record.get(byHead, branch), {
      onNone: () =>
        Result.fail(
          Option.match(Array.head(above), {
            onNone: () => `${branch} has no open pull request`,
            onSome: (bottom) =>
              `#${bottom.number} targets ${branch}, which is not ${trunk} and has no open pull request`,
          }),
        ),
      onSome: (pull) =>
        Array.contains(above, pull)
          ? Result.fail(`the base branches loop at #${pull.number}`)
          : walk(pull.baseRefName, Array.prepend(above, pull)),
    });
  };
  return walk(top, []);
};

export const CheckSummary = Schema.Struct({
  passed: Schema.Array(Schema.String),
  pending: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
});
export type CheckSummary = typeof CheckSummary.Type;

const isPassed = Schema.is(Schema.Literals(["SUCCESS", "NEUTRAL", "SKIPPED"]));
const isWaiting = Schema.is(Schema.Literals(["PENDING", "EXPECTED"]));

// Sorts a pull request's checks into passed, pending and failed names.
export const checkSummary = (pull: Pick<PullRequest, "statusCheckRollup">): CheckSummary => {
  const checks = Option.getOrElse(Option.fromNullOr(pull.statusCheckRollup), Array.empty);
  const sorted = Array.map(checks, (check) => {
    const { name, done, outcome } = Check.match(check, {
      CheckRun: (run) => ({
        name: run.name,
        done: run.status === "COMPLETED",
        outcome: run.conclusion,
      }),
      StatusContext: (status) => ({
        name: status.context,
        done: !isWaiting(status.state),
        outcome: status.state,
      }),
    });
    const state: keyof CheckSummary = !done ? "pending" : isPassed(outcome) ? "passed" : "failed";
    return { name, state };
  });
  const named = (state: keyof CheckSummary) =>
    Array.map(
      Array.filter(sorted, (check) => check.state === state),
      (check) => check.name,
    );
  return { passed: named("passed"), pending: named("pending"), failed: named("failed") };
};

// `reason` when `holds` is true.
const when = (holds: boolean, reason: string): Option.Option<string> =>
  holds ? Option.some(reason) : Option.none();

// "<label>: a, b" when `names` is not empty.
const listed = (label: string, names: ReadonlyArray<string>): Option.Option<string> =>
  Array.match(names, {
    onEmpty: () => Option.none(),
    onNonEmpty: (some) => Option.some(`${label}: ${Array.join(some, ", ")}`),
  });

// Every reason a pull request may not land; an empty list means it may.
export const blockers = (pull: PullRequest): Array<string> => {
  const reviewed =
    pull.reviewDecision === "APPROVED" ||
    Array.some(pull.labels, (label) => label.name === REVIEWED_LABEL);
  const checks = checkSummary(pull);
  return Array.getSomes([
    when(pull.isDraft, "is a draft"),
    when(!reviewed, `is not approved and has no "${REVIEWED_LABEL}" label`),
    // GitHub starts workflows only after it has computed the merge, so anything else can hide checks that have not started.
    when(pull.mergeable !== "MERGEABLE", `mergeable state is ${pull.mergeable}`),
    listed("failed checks", checks.failed),
    listed("pending checks", checks.pending),
    when(
      Array.every([checks.failed, checks.pending, checks.passed], Array.isReadonlyArrayEmpty),
      "has no checks",
    ),
  ]);
};

// The commit each pull request sits on and its own head, bottom first: the trunk, then the head of the one below.
export const links = (
  stack: ReadonlyArray<PullRequest>,
  trunkOid: string,
): Array<readonly [below: string, head: string]> => {
  const heads = Array.map(stack, (pull) => pull.headRefOid);
  return Array.zip(Array.prepend(heads, trunkOid), heads);
};

// The first pull request whose head does not sit on the one below it (the trunk for the bottom), or none when
// the whole stack is a straight line from the trunk. `answers` lines up with `links(stack, trunkOid)`: each says
// whether that link's `below` commit is reachable from its `head`.
export const chainBreak = (
  stack: ReadonlyArray<PullRequest>,
  trunkOid: string,
  answers: ReadonlyArray<boolean>,
): Option.Option<PullRequest> =>
  pipe(
    Array.zipWith(
      Array.zip(stack, links(stack, trunkOid)),
      answers,
      ([pull, [below, head]], isAncestor) => ({ pull, sits: head !== below && isAncestor }),
    ),
    Array.findFirst(({ sits }) => !sits),
    Option.map(({ pull }) => pull),
  );

// Why a pull request whose own commits include merge commits may not land, or none when they are a straight line.
// Landing fast-forwards main, so every merge would show on main as "Merge commit ... into HEAD" in place of the
// commits themselves. `merges` lists the merge commits between the pull request below and this head, as "<sha> <subject>".
export const mergeBlocker = (merges: ReadonlyArray<string>): Option.Option<string> =>
  Array.match(merges, {
    onEmpty: () => Option.none(),
    onNonEmpty: ([first, ...rest]) => {
      const [count, more] = Array.isReadonlyArrayEmpty(rest)
        ? ["1 merge commit", ""]
        : [`${merges.length} merge commits`, ", ..."];
      return Option.some(
        `has ${count} (${first}${more}); rebase it onto the pull request below instead of merging`,
      );
    },
  });
