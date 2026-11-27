import { Effect, Schema } from "effect";
import { VariantSchema } from "effect/schema";

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

export const OrderedAfter = Schema.Struct({ reason: Schema.String, task: TaskId });
export type OrderedAfter = typeof OrderedAfter.Type;

/**
 * The places a task goes. `draft` is a task as the planner proposes it
 * (`spec.planning.planner-service`): only what the model decides. `manifest`, the default, is a task
 * in `manifest.json`, with what `stackOf` and the runs add.
 */
const Task = VariantSchema.make({ defaultVariant: "manifest", variants: ["draft", "manifest"] });

/** A field the model never writes. IDs, branches, parents, worktrees, gates, order and status come from `stackOf`; commits and sessions from the runs. */
const byCairn = Task.FieldOnly(["manifest"]);

const TaskFields = Task.Struct({
  branch: byCairn(Schema.String.check(Schema.isPattern(BRANCH))),
  category: Task.Field({
    draft: Schema.NonEmptyString.annotate({
      description:
        "The name of one of the categories the prompt lists, for the kind of work the task is.",
    }),
    manifest: Schema.optionalKey(Schema.NonEmptyString),
  }),
  commits: byCairn(Schema.Array(Sha)),
  /** A draft names the drafts it needs by title, which code resolves to IDs; a title is unique among one reply's drafts. */
  dependsOn: Task.Field({
    draft: Schema.Array(Schema.NonEmptyString).annotate({
      description:
        "The exact titles of the other tasks in this plan, or the IDs of tasks already planned, that must land first.",
    }),
    manifest: Schema.Array(TaskId),
  }),
  files: Schema.Array(Schema.String).annotate({
    description: "The files the task creates or changes.",
  }),
  humanGate: byCairn(HumanGate),
  id: byCairn(TaskId),
  model: Task.Field({
    draft: Schema.NonEmptyString.annotate({
      description: "A proposed model for the task, named as in the config's model table.",
    }),
    manifest: Schema.NonEmptyString,
  }),
  /** A conflict ordering, not a dependency: this task is built after `task` for the `reason`. */
  orderedAfter: byCairn(
    Schema.Array(OrderedAfter).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  ),
  parent: byCairn(Schema.NullOr(TaskId)),
  prdSections: Schema.NonEmptyArray(PrdSectionId),
  reasoning: Reasoning,
  sessions: byCairn(Schema.Array(SessionId)),
  specSections: Schema.NonEmptyArray(SpecSectionId),
  status: byCairn(TaskStatus),
  title: Schema.NonEmptyString.annotate({
    description: "A short imperative title, unique among the tasks in this plan.",
  }),
  worktree: byCairn(Schema.NullOr(Schema.String)),
});

export const ManifestTask = Task.extract(TaskFields, "manifest");
export type ManifestTask = typeof ManifestTask.Type;

/**
 * One task as the planner proposes it. It holds only what the model decides; the rest comes later,
 * from `stackOf`.
 */
export const TaskDraft = Task.extract(TaskFields, "draft");
export type TaskDraft = typeof TaskDraft.Type;

export const Manifest = Schema.Struct({
  baseBranch: Schema.NonEmptyString,
  feature: Slug,
  tasks: Schema.NonEmptyArray(ManifestTask),
  version: Schema.Literal(1),
});
export type Manifest = typeof Manifest.Type;
