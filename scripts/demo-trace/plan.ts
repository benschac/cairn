import type { Actor, ManifestTask } from "@cairn/contract";
import { Array, DateTime, Match, Option, pipe, String } from "effect";

/** A commit as `git show` prints it for the demo: its sha, parents, subject, commit time and changed files. */
export interface Shown {
  readonly files: ReadonlyArray<string>;
  readonly parents: ReadonlyArray<string>;
  readonly sha: string;
  readonly subject: string;
  readonly ts: DateTime.Utc;
}

/** The format `git show --no-walk --name-only` is run with: a \x01 byte opens each commit. */
export const SHOW_FORMAT = "%x01%H%n%P%n%s%n%cI";

const nonEmpty = (lines: ReadonlyArray<string>) => Array.filter(lines, String.isNonEmpty);

/** Reads the output of `git show --no-walk --name-only --format=SHOW_FORMAT`, one entry per commit. */
export const parseShown = (output: string): ReadonlyArray<Shown> =>
  Array.getSomes(
    Array.map(nonEmpty(String.split(output, "\x01")), (block) => {
      const lines = String.split(block, "\n");
      return Option.all({
        sha: Array.get(lines, 0),
        parents: Option.map(Array.get(lines, 1), (line) => nonEmpty(String.split(line, " "))),
        subject: Array.get(lines, 2),
        ts: Option.flatMap(Array.get(lines, 3), (line) => DateTime.make(line)),
        files: Option.some(nonEmpty(Array.drop(lines, 4))),
      }).pipe(Option.map(({ ts, ...rest }) => ({ ...rest, ts: DateTime.toUtc(ts) })));
    }),
  );

/** One event the demo records for a task. */
export interface DemoEvent {
  readonly actor: Actor;
  readonly model?: string;
  readonly reasoning?: string;
  readonly status: "running" | "blocked_on_human" | "failed" | "done";
  readonly taskId: string;
  readonly ts: string;
}

/**
 * The events that reach the task's recorded status: `running`, then `blocked_on_human` and a human's
 * `done` when the task is gated, else the orchestrator's `done`. A running task has `running` alone, a
 * failed one `running` then `failed`, a blocked one `running` then `blocked_on_human`, and a pending one none. The `running` event names the model and reasoning only for a task with a recorded session, the one
 * sign that an agent ran it; any other task shows as planned. `landed` is not an event here: the task's commits are on the base, and the derivation lands it.
 */
export const eventsOf = (
  task: Pick<ManifestTask, "id" | "model" | "reasoning" | "sessions" | "status">,
  gated: boolean,
  approver: Actor,
  ts: DateTime.Utc,
): ReadonlyArray<DemoEvent> => {
  const at = DateTime.formatIso(ts);
  const event = (actor: Actor, status: DemoEvent["status"]): DemoEvent => ({
    actor,
    ...(status === "running" && Array.isReadonlyArrayNonEmpty(task.sessions)
      ? { model: task.model, reasoning: task.reasoning }
      : {}),
    status,
    taskId: task.id,
    ts: at,
  });
  return Match.value(task.status).pipe(
    Match.when("pending", (): ReadonlyArray<DemoEvent> => []),
    Match.when("running", () => [event("orchestrator", "running")]),
    Match.when("failed", () => [event("orchestrator", "running"), event("orchestrator", "failed")]),
    Match.when("blocked_on_human", () => [
      event("orchestrator", "running"),
      event("orchestrator", "blocked_on_human"),
    ]),
    Match.orElse(() =>
      gated
        ? [
            event("orchestrator", "running"),
            event("orchestrator", "blocked_on_human"),
            event(approver, "done"),
          ]
        : [event("orchestrator", "running"), event("orchestrator", "done")],
    ),
  );
};

/** The latest time, or `fallback` when there is none. */
export const latest = (times: ReadonlyArray<DateTime.Utc>, fallback: DateTime.Utc): DateTime.Utc =>
  pipe(
    Array.sort(times, DateTime.Order),
    Array.last,
    Option.getOrElse(() => fallback),
  );

/** Where two texts first differ, as a line number and both lines, or none when they are equal. */
export const firstDifference = (expected: string, actual: string): Option.Option<string> => {
  const a = String.split(expected, "\n");
  const b = String.split(actual, "\n");
  return pipe(
    Array.range(0, Math.max(a.length, b.length) - 1),
    Array.findFirst((i) => a[i] !== b[i]),
    Option.map(
      (i) =>
        `line ${i + 1}: committed ${JSON.stringify(a[i] ?? "(end of file)")}, generated ${JSON.stringify(b[i] ?? "(end of file)")}`,
    ),
  );
};
