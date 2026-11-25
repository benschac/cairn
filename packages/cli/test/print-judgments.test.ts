import { Judgment } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Schema, String } from "effect";

import { changeLines, flagsOf, reportLines, targetName } from "../src/print-judgments.ts";

const Judgments = Schema.Array(Judgment);

const isChange = (judgment: Judgment) => judgment.action !== "none";
const isReport = (judgment: Judgment) => judgment.action === "none" && judgment.verdict !== "pass";

it.prop(
  "a line for each judgment that changed something, and for each that reported and changed nothing",
  [Judgments],
  ([judgments]) => {
    expect(Array.length(changeLines(judgments))).toBe(
      Array.length(Array.filter(judgments, isChange)),
    );
    expect(Array.length(reportLines(judgments))).toBe(
      Array.length(Array.filter(judgments, isReport)),
    );
    // A judgment is printed once: what acted is a change, never also a report.
    expect(
      Array.length(changeLines(judgments)) + Array.length(reportLines(judgments)),
    ).toBeLessThanOrEqual(Array.length(judgments));
  },
);

it.prop(
  "the flags are the reported judgments whose verdict is flag",
  [Judgments],
  ([judgments]) => {
    expect(flagsOf(judgments)).toBe(
      Array.length(
        Array.filter(judgments, (judgment) => isReport(judgment) && judgment.verdict === "flag"),
      ),
    );
    expect(flagsOf(judgments)).toBeLessThanOrEqual(Array.length(reportLines(judgments)));
  },
);

it.prop("each line names its target and what the judgment said", [Judgments], ([judgments]) => {
  const changes = Array.filter(judgments, isChange);
  expect(
    Array.every(
      Array.zip(changes, changeLines(judgments)),
      ([judgment, line]) =>
        String.startsWith(`${judgment.action}  ${targetName(judgment.target)}: `)(line) &&
        String.endsWith(judgment.message)(line),
    ),
  ).toBe(true);
  const reports = Array.filter(judgments, isReport);
  expect(
    Array.every(Array.zip(reports, reportLines(judgments)), ([judgment, line]) =>
      String.startsWith(
        `${targetName(judgment.target)} judge:${judgment.question} ${judgment.verdict} `,
      )(line),
    ),
  ).toBe(true);
});
