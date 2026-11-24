import { Manifest, ManifestTask } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Schema, String } from "effect";

import { stackLines } from "../src/print-stack.ts";

const task = (number: 1 | 2 | 3 | 4, parent: string | null, gated: boolean) => {
  const id = `t${number}`;
  return Schema.decodeSync(ManifestTask)({
    branch: `plan/0${number}-task`,
    commits: [],
    dependsOn: parent === null ? [] : [parent],
    files: [],
    humanGate: { reasons: gated ? ["tag:human"] : [], required: gated },
    id,
    model: "sonnet",
    parent,
    prdSections: ["prd.capture"],
    reasoning: "high",
    sessions: [],
    specSections: ["spec.capture"],
    status: "pending",
    title: `Title of ${id}`,
    worktree: null,
  });
};

const isHeader = (line: string) => /^Stack \d+$/u.test(line);

it("prints each stack as a tree, a task under its parent, marking gates and new tasks", () => {
  const tasks = [task(1, null, true), task(2, null, false), task(3, "t1", false)];
  expect(stackLines(tasks, { isNew: (candidate) => candidate.id === "t3" })).toEqual([
    "Stack 1",
    "  t1  pending  Title of t1  sonnet/high  GATE",
    "    t3  pending  Title of t3  sonnet/high  new",
    "Stack 2",
    "  t2  pending  Title of t2  sonnet/high",
  ]);
});

it("keeps a task's children together when the stack was ordered breadth first", () => {
  const tasks = [
    task(1, null, false),
    task(2, "t1", false),
    task(3, "t1", false),
    task(4, "t2", false),
  ];
  expect(stackLines(tasks)).toEqual([
    "Stack 1",
    "  t1  pending  Title of t1  sonnet/high",
    "    t2  pending  Title of t2  sonnet/high",
    "      t4  pending  Title of t4  sonnet/high",
    "    t3  pending  Title of t3  sonnet/high",
  ]);
});

it.prop("prints every task once, in stacks numbered from 1", [Manifest], ([manifest]) => {
  const lines = stackLines(manifest.tasks);
  const headers = Array.filter(lines, isHeader);
  expect(Array.length(lines) - Array.length(headers)).toBe(Array.length(manifest.tasks));
  expect(headers).toEqual(Array.makeBy(Array.length(headers), (at) => `Stack ${at + 1}`));
});

it.prop("marks every task new when told to", [Manifest], ([manifest]) => {
  const lines = Array.filter(
    stackLines(manifest.tasks, { isNew: () => true }),
    (line) => !isHeader(line),
  );
  expect(Array.every(lines, String.endsWith("  new"))).toBe(true);
});
