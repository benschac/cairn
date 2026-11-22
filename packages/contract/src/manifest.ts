import { Schema } from "effect";

import { PrdSectionId, SpecSectionId, TaskId } from "./ids.ts";
import { SessionId, Sha } from "./trailers.ts";

export const TaskStatus = Schema.Literals([
  "pending",
  "running",
  "blocked_on_human",
  "failed",
  "done",
  "landed",
]);
export type TaskStatus = typeof TaskStatus.Type;

/** A lowercase kebab-case name, such as `cairn-mvp`. */
export const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)).pipe(
  Schema.brand("Slug"),
);
export type Slug = typeof Slug.Type;

export const Reasoning = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Reasoning = typeof Reasoning.Type;

/** Why a task needs a human: a `human` tag, or a path glob it touches. */
export const GateReason = Schema.Union([
  Schema.Literal("tag:human"),
  Schema.TemplateLiteral(["path:", Schema.String]),
]);
export type GateReason = typeof GateReason.Type;

const BRANCH = /^[a-z0-9]+(?:-[a-z0-9]+)*\/\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const ManifestTask = Schema.Struct({
  branch: Schema.String.check(Schema.isPattern(BRANCH)),
  commits: Schema.Array(Sha),
  dependsOn: Schema.Array(TaskId),
  files: Schema.Array(Schema.String),
  humanGate: Schema.Struct({
    reasons: Schema.Array(GateReason),
    required: Schema.Boolean,
  }),
  id: TaskId,
  model: Schema.NonEmptyString,
  parent: Schema.NullOr(TaskId),
  prdSections: Schema.NonEmptyArray(PrdSectionId),
  reasoning: Reasoning,
  sessions: Schema.Array(SessionId),
  specSections: Schema.NonEmptyArray(SpecSectionId),
  status: TaskStatus,
  title: Schema.NonEmptyString,
  worktree: Schema.NullOr(Schema.String),
});
export type ManifestTask = typeof ManifestTask.Type;

export const Manifest = Schema.Struct({
  baseBranch: Schema.NonEmptyString,
  feature: Slug,
  tasks: Schema.NonEmptyArray(ManifestTask),
  version: Schema.Literal(1),
});
export type Manifest = typeof Manifest.Type;
