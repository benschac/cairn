import { Schema } from "effect";

import { KEBAB, PrdSectionId, SpecSectionId, TaskId } from "./ids.ts";
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

/** A section's rolled-up status: a task status, or one only a section can have. */
export const SectionStatus = Schema.Literals([
  "deferred",
  "context",
  "unmapped",
  "blocked_on_human",
  "failed",
  "running",
  "landed",
  "done",
  "pending",
  "in_progress",
]);
export type SectionStatus = typeof SectionStatus.Type;

/** A lowercase kebab-case name, such as `cairn-mvp`. */
export const Slug = Schema.String.check(Schema.isPattern(new RegExp(`^${KEBAB}$`, "u"))).pipe(
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

/** Whether a task waits for a human before it lands, and why. */
export const HumanGate = Schema.Struct({
  reasons: Schema.Array(GateReason),
  required: Schema.Boolean,
});
export type HumanGate = typeof HumanGate.Type;

const BRANCH = new RegExp(String.raw`^${KEBAB}/\d{2,}-${KEBAB}$`, "u");

export const ManifestTask = Schema.Struct({
  branch: Schema.String.check(Schema.isPattern(BRANCH)),
  commits: Schema.Array(Sha),
  dependsOn: Schema.Array(TaskId),
  files: Schema.Array(Schema.String),
  humanGate: HumanGate,
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
