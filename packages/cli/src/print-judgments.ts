import { JudgmentTarget } from "@cairn/contract";
import type { Judgment } from "@cairn/contract";
import { Array, Result } from "effect";

/** How a judgment names its target in the plan's output and when it is matched to another. */
export const targetName: (target: JudgmentTarget) => string = JudgmentTarget.match({
  draft: ({ title }) => `draft "${title}"`,
  section: ({ id }) => id,
  stack: () => "stack",
  task: ({ id }) => id,
});

/**
 * What judging changed (`spec.judging.checkpoints`): a line for each judgment whose action is
 * `split` or `routed`, with the reason the judgment gave.
 */
export const changeLines = (judgments: ReadonlyArray<Judgment>): ReadonlyArray<string> =>
  Array.filterMap(judgments, ({ action, message, target }) =>
    action === "none"
      ? Result.failVoid
      : Result.succeed(`${action}  ${targetName(target)}: ${message}`),
  );

/** The judgments that reported something and changed nothing: a `flag` or an `unsure`. */
const reported = (judgments: ReadonlyArray<Judgment>) =>
  Array.filter(
    judgments,
    ({ action, verdict }) => action === "none" && (verdict === "flag" || verdict === "unsure"),
  );

/** A line for each `flag` or `unsure` judgment that acted on nothing: `<target> judge:<question> <verdict> <message>`. */
export const reportLines = (judgments: ReadonlyArray<Judgment>): ReadonlyArray<string> =>
  Array.map(
    reported(judgments),
    ({ message, question, target, verdict }) =>
      `${targetName(target)} judge:${question} ${verdict} ${message}`,
  );

/** How many judgments flag something that planning did not act on: the flags of a dry run's totals. */
export const flagsOf = (judgments: ReadonlyArray<Judgment>): number =>
  Array.length(Array.filter(reported(judgments), ({ verdict }) => verdict === "flag"));
