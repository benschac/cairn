import { EventJson } from "@cairn/contract";
import type { TaskStatus } from "@cairn/contract";
import { traceOf } from "@cairn/core";
import {
  Array,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  String,
} from "effect";
import { Argument, Command } from "effect/cli";

import { Git } from "../git.ts";
import { layer as gitLayer } from "../git-live.ts";
import { loadTraceInput } from "../load-trace.ts";
import { MainCheckout } from "../main-checkout.ts";
import { CAIRN_DIRECTORY } from "../workspace.ts";

const EVENTS_FILE = "events.jsonl";

/** `cairn approve` will not record the approval: `reason` says why. */
export class ApprovalRefused extends Schema.TaggedError<
  ApprovalRefused,
  { readonly brand: unique symbol }
>()("ApprovalRefused", { reason: Schema.String }) {
  override get message() {
    return this.reason;
  }
}

const encodeEvent = Schema.encodeSync(EventJson);

/**
 * `cairn approve <taskId>`: appends `{ status: "done", actor: "human:<git user.name>" }` to the main
 * checkout's `.cairn/events.jsonl`, creating it when missing, and returns the task's new derived
 * status. It refuses an unknown task, a task that is not `blocked_on_human` and a repository with
 * no `user.name`, and writes nothing then.
 */
export const approve = Effect.fn("approve")(function* (taskId: string) {
  const git = yield* Git;
  const before = yield* Effect.map(loadTraceInput, traceOf);
  const task = yield* Effect.fromOption(
    Array.findFirst(before.tasks, (candidate) => candidate.id === taskId),
  ).pipe(
    Effect.mapError(
      () => new ApprovalRefused({ reason: `${taskId} is not a task in the manifest` }),
    ),
  );
  yield* Effect.filterOrFail(
    Effect.succeed(task.status),
    (status) => status === "blocked_on_human",
    (status) =>
      new ApprovalRefused({
        reason: `${taskId} is ${status}, not blocked_on_human; only a task waiting on a human can be approved`,
      }),
  );
  const name = yield* Effect.flatMap(git.userName, (found) =>
    Effect.fromOption(found).pipe(
      Effect.mapError(
        () =>
          new ApprovalRefused({
            reason:
              "git user.name is not set; run git config user.name <name> to approve as yourself",
          }),
      ),
    ),
  );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  const file = path.join(root, CAIRN_DIRECTORY, EVENTS_FILE);
  const existing = yield* fs
    .exists(file)
    .pipe(Effect.flatMap((present) => (present ? fs.readFileString(file) : Effect.succeed(""))));
  const line = encodeEvent({
    actor: `human:${name}`,
    status: "done",
    taskId: task.id,
    ts: yield* DateTime.now,
    v: 1,
  });
  // A file that does not end in a newline would take the event onto its last line.
  const lead = String.isEmpty(existing) || String.endsWith("\n")(existing) ? "" : "\n";
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${lead}${line}\n`, { flag: "a" });
  const after = yield* Effect.map(loadTraceInput, traceOf);
  const status: TaskStatus = Option.match(
    Array.findFirst(after.tasks, (candidate) => candidate.id === taskId),
    { onNone: () => task.status, onSome: (fresh) => fresh.status },
  );
  yield* Console.log(`${taskId} ${status}`);
  return status;
});

export const approveCommand = Command.make(
  "approve",
  {
    taskId: Argument.String("taskId").pipe(
      Argument.withDescription("The task to approve, such as t12"),
    ),
  },
  ({ taskId }) =>
    approve(taskId).pipe(
      Effect.asVoid,
      Effect.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const root = yield* (yield* MainCheckout).root;
            return gitLayer(root);
          }),
        ),
      ),
    ),
).pipe(Command.withDescription("Record a human's approval of a task waiting at a gate"));
