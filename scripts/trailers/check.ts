// Pure core of scripts/trailers/commit-msg.ts: which trailers a task's commit message lacks.

import type { ManifestTask } from "@cairn/contract";
import { Array, Option, pipe, String } from "effect";

const TRAILER_LINE = /^Cairn-(Task|Section):[ \t]*(.*?)[ \t]*$/u;

// The value of every `Cairn-<key>:` line among the trailers, in order.
const valuesOf = (trailers: string, key: "Task" | "Section"): Array<string> =>
  pipe(
    String.split(trailers, /\r?\n/u),
    Array.map((line) =>
      pipe(
        String.match(TRAILER_LINE)(line),
        Option.filter(([, found]) => found === key),
        Option.map(([, , value = ""]) => value),
      ),
    ),
    Array.getSomes,
  );

// What is wrong with a commit's trailers for this task; empty when it carries them. `trailers` is the trailer block
// as `git interpret-trailers --parse` prints it, so what counts as a trailer is what git, and so landing, reads.
export const trailerProblems = (task: ManifestTask, trailers: string): Array<string> => {
  const tasks = valuesOf(trailers, "Task");
  const sections = valuesOf(trailers, "Section");
  return Array.appendAll(
    Array.match(tasks, {
      onEmpty: () => [`no Cairn-Task trailer`],
      onNonEmpty: ([only, ...rest]) =>
        Array.isReadonlyArrayNonEmpty(rest)
          ? ["more than one Cairn-Task trailer"]
          : only === task.id
            ? []
            : [`Cairn-Task names ${only}, not ${task.id}`],
    }),
    Array.some(sections, (section) => Array.contains(task.specSections, section))
      ? []
      : [
          Array.isReadonlyArrayNonEmpty(sections)
            ? `no Cairn-Section names a section of ${task.id}`
            : "no Cairn-Section trailer",
        ],
  );
};

// The trailer lines to add to the message: the task, and each spec section it lists (one is enough).
export const trailersToAdd = (task: ManifestTask): string =>
  Array.join(
    Array.prepend(
      Array.map(task.specSections, (section) => `Cairn-Section: ${section}`),
      `Cairn-Task: ${task.id}`,
    ),
    "\n",
  );

// The refusal to print for a commit on this task's branch, or none when its trailers are there.
export const refusal = (task: ManifestTask, trailers: string): Option.Option<string> =>
  Option.map(
    Option.liftPredicate(trailerProblems(task, trailers), Array.isReadonlyArrayNonEmpty),
    (problems) =>
      Array.join(
        [
          `Commit refused: the message lacks the trailers of ${task.id} (${task.branch}): ${Array.join(problems, "; ")}.`,
          "Landing is read from trailers. End the message with a paragraph of trailers, keeping at least one Cairn-Section line:",
          "",
          trailersToAdd(task),
        ],
        "\n",
      ),
  );
