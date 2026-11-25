// Pure core of scripts/trailers/commit-msg.ts: which trailers a task's commit message lacks.

import type { ManifestTask } from "@cairn/contract";
import { Array, Option, pipe, String } from "effect";

const TRAILER_LINE = /^Cairn-(Task|Section):[ \t]*(.*?)[ \t]*$/u;

// The last paragraph of the message, where git reads trailers, once comment lines are dropped. A message of one
// paragraph has none: git takes that paragraph for the subject.
const trailerBlock = (message: string): string =>
  pipe(
    String.split(message, /\r?\n/u),
    Array.filter((line) => !String.startsWith("#")(line)),
    Array.join("\n"),
    String.trim,
    String.split(/\n[ \t]*\n/u),
    Array.drop(1),
    Array.last,
    Option.getOrElse(() => ""),
  );

// The value of every `Cairn-<key>:` line in the message's trailer block, in order.
const valuesOf = (message: string, key: "Task" | "Section"): Array<string> =>
  pipe(
    String.split(trailerBlock(message), /\n/u),
    Array.map((line) =>
      pipe(
        String.match(TRAILER_LINE)(line),
        Option.filter(([, found]) => found === key),
        Option.map(([, , value = ""]) => value),
      ),
    ),
    Array.getSomes,
  );

// What is wrong with the message's trailers for this task; empty when it carries them.
export const trailerProblems = (task: ManifestTask, message: string): Array<string> => {
  const tasks = valuesOf(message, "Task");
  const sections = valuesOf(message, "Section");
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

// The refusal to print for a commit on this task's branch, or none when the message carries its trailers.
export const refusal = (task: ManifestTask, message: string): Option.Option<string> =>
  Option.map(
    Option.liftPredicate(trailerProblems(task, message), Array.isReadonlyArrayNonEmpty),
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
