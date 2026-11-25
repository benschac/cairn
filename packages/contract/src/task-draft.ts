import { Schema } from "effect";

import { PrdSectionId, SpecSectionId } from "./ids.ts";
import { Reasoning } from "./manifest.ts";

/**
 * One task as the planner proposes it (`spec.planning.planner-service`). It holds only what the
 * model decides. IDs, branches, parents, worktrees, gates, order and status are deterministic and
 * come later, from `stackOf`.
 *
 * A draft names the drafts it depends on by `title`, so the reference is text the model can copy
 * and code can resolve: a title is unique among one reply's drafts.
 */
export const TaskDraft = Schema.Struct({
  dependsOn: Schema.Array(Schema.NonEmptyString).annotate({
    description:
      "The exact titles of the other tasks in this plan, or the IDs of tasks already planned, that must land first.",
  }),
  files: Schema.Array(Schema.String).annotate({
    description: "The files the task creates or changes.",
  }),
  model: Schema.NonEmptyString.annotate({
    description: "A proposed model for the task, named as in the config's model table.",
  }),
  prdSections: Schema.NonEmptyArray(PrdSectionId),
  reasoning: Reasoning,
  specSections: Schema.NonEmptyArray(SpecSectionId),
  title: Schema.NonEmptyString.annotate({
    description: "A short imperative title, unique among the tasks in this plan.",
  }),
});
export type TaskDraft = typeof TaskDraft.Type;

export const TaskDraftsJson = Schema.fromJsonString(Schema.Array(TaskDraft));
