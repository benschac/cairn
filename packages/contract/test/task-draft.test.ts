import { expect, it } from "@effect/vitest";
import { Array, Exit, Order, Record, Schema, Struct } from "effect";

import { ManifestTask, TaskDraft, TaskDraftsJson } from "../src/index.ts";

const encode = Schema.encodeSync(TaskDraft);
const decodeExit = Schema.decodeUnknownExit(TaskDraft);

it.prop("a list of drafts round-trips through JSON", [Schema.Array(TaskDraft)], ([drafts]) => {
  const json = Schema.encodeSync(TaskDraftsJson)(drafts);
  expect(Schema.decodeSync(TaskDraftsJson)(json)).toEqual(drafts);
});

it.prop("a draft refuses each field the model must give", [TaskDraft], ([draft]) => {
  const encoded = encode(draft);
  const refused = Array.map(
    [
      "category",
      "dependsOn",
      "files",
      "model",
      "prdSections",
      "reasoning",
      "specSections",
      "title",
    ] as const,
    (key) => Exit.isFailure(decodeExit(Struct.omit(encoded, [key]))),
  );
  expect(refused).toEqual(Array.replicate(true, 8));
});

it.prop(
  "a draft keeps nothing the code decides, even when the model sends it",
  [TaskDraft],
  ([draft]) => {
    const sent = Record.union(
      encode(draft),
      {
        branch: "feature/01-x",
        humanGate: { reasons: [], required: false },
        id: "t1",
        parent: null,
      },
      (kept) => kept,
    );
    const keys = Array.sort(Record.keys(Schema.decodeUnknownSync(TaskDraft)(sent)), Order.String);
    expect(keys).toEqual([
      "category",
      "dependsOn",
      "files",
      "model",
      "prdSections",
      "reasoning",
      "specSections",
      "title",
    ]);
  },
);

it.prop("a draft with no spec section is refused", [TaskDraft], ([draft]) => {
  expect(Exit.isFailure(decodeExit(Record.set(encode(draft), "specSections", [])))).toBe(true);
});

it("a manifest task has every field of a draft, and the fields only Cairn writes", () => {
  const draft = Array.sort(Struct.keys(TaskDraft.fields), Order.String);
  const task = Array.sort(Struct.keys(ManifestTask.fields), Order.String);
  expect(Array.difference(draft, task)).toEqual([]);
  expect(Array.difference(task, draft)).toEqual([
    "branch",
    "commits",
    "humanGate",
    "id",
    "orderedAfter",
    "parent",
    "sessions",
    "status",
    "worktree",
  ]);
});
