// Land a reviewed stack of pull requests on main with one fast-forward push.
//
//   pnpm land [--branch <top branch>]          print the plan and what blocks it
//   pnpm land [--branch <top branch>] --push   retarget the pull requests to main, then push
//
// The stack is the chain of open pull requests from <top branch> (default: the
// current branch) down to main. It lands only when every pull request is
// approved or carries the "reviewed" label, has passing checks, and the chain
// is a straight line from the current main.
//
// GitHub marks a pull request merged when its head commits become reachable
// from its base branch, so each one is retargeted to main before the push. The
// commits keep the SHAs their checks ran on, and main shows them as they are, so a
// stack with merge commits is refused: rebase it instead.

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Array,
  Console,
  Effect,
  Layer,
  Logger,
  Option,
  Path,
  Ref,
  Result,
  Runtime,
  Schedule,
  Schema,
  Stream,
  String,
} from "effect";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  blockers,
  chainBreak,
  checkSummary,
  links,
  mergeBlocker,
  orderStack,
  PULL_FIELDS,
  PullRequest,
} from "./plan.ts";

const TRUNK = "main";
const REMOTE = "origin";
const LIST_LIMIT = 300;
const MERGE_WAIT = "2 minutes";
const MERGE_POLL = "5 seconds";

// Each expected failure logs its own message once (see the command below), so the runtime is told not to print it again.
class MissingTopBranch extends Schema.TaggedError<MissingTopBranch>()("MissingTopBranch", {
  current: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `Name the top branch of the stack with --branch (current branch: ${String.isEmpty(this.current) ? "none" : this.current})`;
  }
}

class TooManyPullRequests extends Schema.TaggedError<TooManyPullRequests>()("TooManyPullRequests", {
  limit: Schema.Int,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `More than ${this.limit - 1} open pull requests; raise LIST_LIMIT`;
  }
}

class StackNotFound extends Schema.TaggedError<StackNotFound>()("StackNotFound", {
  reason: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `Cannot find the stack: ${this.reason}`;
  }
}

class StackBlocked extends Schema.TaggedError<StackBlocked>()("StackBlocked", {
  blocked: Schema.Int,
  total: Schema.Int,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `${this.blocked} of ${this.total} pull requests are blocked; nothing was changed`;
  }
}

class PushRefused extends Schema.TaggedError<PushRefused>()("PushRefused", {
  restored: Schema.Int,
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `Nothing landed; restored ${this.restored} base branches. ${this.detail}`;
  }
}

class MergeNotRecorded extends Schema.TaggedError<MergeNotRecorded>()("MergeNotRecorded", {
  numbers: Schema.Array(Schema.Int),
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    const pulls = Array.join(
      Array.map(this.numbers, (number) => `#${number}`),
      ", ",
    );
    return `The commits are on ${TRUNK}, but GitHub has not marked these merged: ${pulls}. Check them before closing by hand.`;
  }
}

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    const line = Array.join(Array.prepend(this.args, this.command), " ");
    return `${line} exited with ${this.exitCode}${String.isNonEmpty(this.stderr) ? `: ${this.stderr}` : ""}`;
  }
}

// A commit's abbreviated hash.
const short = (oid: string) => String.takeLeft(oid, 7);

const decodePullRequests = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PullRequest)),
);

const land = Effect.fn("land")(function* ({
  branch,
  push,
}: {
  branch: Option.Option<string>;
  push: boolean;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const repo = yield* path.fromFileUrl(new URL("../../", import.meta.url));

  // Runs a command in the repository and returns its trimmed stdout; a non-zero exit fails with its stderr.
  const sh = (command: string, args: string[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: repo }));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return yield* new CommandFailed({ command, args, exitCode, stderr: String.trim(stderr) });
        }
        return String.trim(stdout);
      }),
    );
  const isAncestor = (a: string, b: string) => {
    const args = ["merge-base", "--is-ancestor", a, b];
    return spawner
      .exitCode(ChildProcess.make("git", args, { cwd: repo }))
      .pipe(
        Effect.flatMap((exitCode) =>
          exitCode === 0 || exitCode === 1
            ? Effect.succeed(exitCode === 0)
            : Effect.fail(new CommandFailed({ command: "git", args, exitCode, stderr: "" })),
        ),
      );
  };

  const top = yield* Option.match(branch, {
    onNone: () => sh("git", ["branch", "--show-current"]),
    onSome: Effect.succeed,
  });
  if (String.isEmpty(top) || top === TRUNK) return yield* new MissingTopBranch({ current: top });

  yield* sh("git", ["fetch", "--quiet", REMOTE]);
  const trunkOid = yield* sh("git", ["rev-parse", `${REMOTE}/${TRUNK}`]);
  const pulls = yield* sh("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--limit",
    `${LIST_LIMIT}`,
    "--json",
    PULL_FIELDS,
  ]).pipe(Effect.flatMap(decodePullRequests));
  if (pulls.length === LIST_LIMIT) return yield* new TooManyPullRequests({ limit: LIST_LIMIT });

  const stack = yield* Effect.fromResult(
    Result.mapError(orderStack(pulls, top, TRUNK), (reason) => new StackNotFound({ reason })),
  );
  const tip = Array.lastNonEmpty(stack).headRefOid;

  // Ask git about each pull request and the one below it once, then answer chainBreak from the results.
  const pairs = links(stack, trunkOid);
  const answers = yield* Effect.forEach(pairs, ([a, b]) => isAncestor(a, b), { concurrency: 4 });
  const broken = chainBreak(stack, trunkOid, answers);
  // The merge commits each pull request adds over the one below it, as "<sha> <subject>".
  const merges = yield* Effect.forEach(
    pairs,
    ([a, b]) =>
      sh("git", ["log", "--merges", "--format=%h %s", `${a}..${b}`]).pipe(
        Effect.map((out) => Array.filter(String.split(out, "\n"), String.isNonEmpty)),
      ),
    { concurrency: 4 },
  );

  const rows = Array.zipWith(stack, merges, (pull, merged) => {
    const brokenReason = Option.contains(broken, pull)
      ? Option.some(
          pull === Array.headNonEmpty(stack)
            ? `does not sit on the current ${TRUNK}`
            : "does not sit on the pull request below it",
        )
      : Option.none<string>();
    return {
      pull,
      checks: checkSummary(pull),
      reasons: Array.flatten([
        Array.fromOption(brokenReason),
        Array.fromOption(mergeBlocker(merged)),
        blockers(pull),
      ]),
    };
  });
  const blocked = Array.countBy(rows, (row) => Array.isReadonlyArrayNonEmpty(row.reasons));

  const report = Array.prepend(
    Array.flatMap(rows, ({ pull, checks, reasons }) =>
      Array.appendAll(
        [
          `  #${pull.number} ${short(pull.headRefOid)} ${pull.headRefName}: ${pull.title}`,
          `      checks ${checks.passed.length} passed, ${checks.pending.length} pending, ${checks.failed.length} failed${Array.isReadonlyArrayNonEmpty(reasons) ? "" : "; ready"}`,
        ],
        Array.map(reasons, (reason) => `      blocked: ${reason}`),
      ),
    ),
    `Stack ending at ${top}: ${stack.length} pull requests onto ${TRUNK} (${short(trunkOid)})`,
  );
  yield* Console.log(Array.join(report, "\n"));
  if (blocked > 0) {
    if (Option.isSome(broken) || Array.some(merges, Array.isReadonlyArrayNonEmpty)) {
      yield* Console.log(
        "Rebase and resubmit first: gt sync, gt restack, gt submit --stack, then wait for the checks. Do not merge a base branch in.",
      );
    }
    return yield* new StackBlocked({ blocked, total: stack.length });
  }

  const retarget = Array.filter(stack, (pull) => pull.baseRefName !== TRUNK);
  if (!push) {
    return yield* Console.log(
      `Ready. --push would retarget ${retarget.length} pull requests to ${TRUNK} and run: git push ${REMOTE} ${short(tip)}:refs/heads/${TRUNK}`,
    );
  }

  const setBase = (pull: PullRequest, base: string) =>
    sh("gh", ["pr", "edit", `${pull.number}`, "--base", base]);
  const retargeted = yield* Ref.make<PullRequest[]>([]);
  // Puts back every base branch already moved to main, then reports why nothing landed.
  const restore = (detail: string) =>
    Effect.gen(function* () {
      const done = yield* Ref.get(retargeted);
      yield* Effect.forEach(done, (pull) => setBase(pull, pull.baseRefName), { discard: true });
      return yield* new PushRefused({ restored: done.length, detail });
    });
  yield* Effect.forEach(
    retarget,
    (pull) =>
      setBase(pull, TRUNK).pipe(
        Effect.andThen(Ref.update(retargeted, (done) => Array.append(done, pull))),
      ),
    { discard: true },
  ).pipe(
    // No force: git refuses unless this is a fast-forward of the remote main.
    Effect.andThen(sh("git", ["push", REMOTE, `${tip}:refs/heads/${TRUNK}`])),
    Effect.catchTags({
      CommandFailed: (failed) =>
        restore(String.isNonEmpty(failed.stderr) ? failed.stderr : failed.message),
      PlatformError: (failed) => restore(failed.message),
    }),
  );
  yield* Effect.logInfo(
    `Pushed ${short(tip)} to ${TRUNK}; waiting for GitHub to mark ${stack.length} pull requests merged`,
  );

  const stateOf = (pull: PullRequest) =>
    sh("gh", ["pr", "view", `${pull.number}`, "--json", "state", "--jq", ".state"]);
  const open = yield* Ref.make<readonly PullRequest[]>(stack);
  const poll = Effect.gen(function* () {
    yield* Effect.sleep(MERGE_POLL);
    const waiting = yield* Ref.get(open);
    const still = yield* Effect.filter(
      waiting,
      (pull) => Effect.map(stateOf(pull), (state) => state !== "MERGED"),
      { concurrency: "unbounded" },
    );
    yield* Ref.set(open, still);
    return still;
  });
  const unmerged = yield* poll.pipe(
    Effect.repeat({ schedule: Schedule.during(MERGE_WAIT), until: Array.isReadonlyArrayEmpty }),
  );
  if (Array.isReadonlyArrayNonEmpty(unmerged)) {
    return yield* new MergeNotRecorded({ numbers: Array.map(unmerged, (pull) => pull.number) });
  }
  return yield* Console.log(
    `Landed ${stack.length} pull requests. Run gt sync to clean up local branches.`,
  );
});

const command = Command.make(
  "land",
  {
    branch: Flag.String("branch").pipe(
      Flag.withDescription("Top branch of the stack (default: the current branch)"),
      Flag.optional,
    ),
    push: Flag.Boolean("push").pipe(
      Flag.withDescription(
        `Retarget the pull requests to ${TRUNK}, then fast-forward ${TRUNK} to the top of the stack`,
      ),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    land(input).pipe(
      // Each expected failure logs its own message once; the runtime prints anything else.
      Effect.tapErrorTag(
        [
          "MissingTopBranch",
          "TooManyPullRequests",
          "StackNotFound",
          "StackBlocked",
          "PushRefused",
          "MergeNotRecorded",
          "CommandFailed",
        ],
        (error) => Effect.logError(error.message),
      ),
    ),
).pipe(
  Command.withDescription(
    `Land a reviewed stack of pull requests on ${TRUNK} with one fast-forward push`,
  ),
);

// Logs go to stderr so stdout holds only the plan.
const logger = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(logger, NodeServices.layer)),
  NodeRuntime.runMain,
);
