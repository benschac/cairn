import { Effect, Schema } from "effect";

import { Event } from "./events.ts";
import { PrdSectionId, SectionId, SpecSectionId, TaskId } from "./ids.ts";
import { Judgment } from "./judgments.ts";
import { HumanGate, ManifestTask, SectionStatus, Slug } from "./manifest.ts";
import { SessionId, Sha } from "./trailers.ts";

export const TraceSection = Schema.Struct({
  human: Schema.Boolean,
  id: SectionId,
  keys: Schema.Struct({
    context: Schema.Array(PrdSectionId),
    defers: Schema.Array(PrdSectionId),
    dependsOn: Schema.Array(SpecSectionId),
    files: Schema.Array(Schema.String),
    implements: Schema.Array(PrdSectionId),
  }),
  level: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  parent: Schema.NullOr(SectionId),
  /** One sentence from spec.json; null in the PRD, for a section the index does not hold, and when the trace has none. */
  summary: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  title: Schema.String,
});
export type TraceSection = typeof TraceSection.Type;

export const TraceDocument = Schema.Struct({
  markdown: Schema.String,
  path: Schema.String,
  sections: Schema.Array(TraceSection),
});
export type TraceDocument = typeof TraceDocument.Type;

export const TraceCommit = Schema.Struct({
  files: Schema.Array(Schema.String),
  parents: Schema.Array(Sha),
  sections: Schema.Array(SpecSectionId),
  session: Schema.NullOr(SessionId),
  sha: Sha,
  subject: Schema.String,
});
export type TraceCommit = typeof TraceCommit.Type;

/** A manifest task as derived state: its status, gate and commits are computed, not snapshotted. */
export const TraceTask = ManifestTask.pipe(
  Schema.fieldsAssign({
    commits: Schema.Array(TraceCommit),
    events: Schema.Array(Event),
    gate: HumanGate,
    waiting: Schema.Boolean,
  }),
);
export type TraceTask = typeof TraceTask.Type;

export const TraceWarningKind = Schema.Literals([
  "illegal-transition",
  "non-human-approval",
  "unknown-task",
  "missing-trailers",
  "landed-without-approval",
  "missing-session",
]);
export type TraceWarningKind = typeof TraceWarningKind.Type;

export const TraceWarning = Schema.Struct({
  kind: TraceWarningKind,
  message: Schema.String,
  sha: Schema.NullOr(Sha),
  taskId: Schema.NullOr(TaskId),
});
export type TraceWarning = typeof TraceWarning.Type;

/** A judgment with whether its input has changed since it was made. */
export const TraceJudgment = Judgment.pipe(Schema.fieldsAssign({ stale: Schema.Boolean }));
export type TraceJudgment = typeof TraceJudgment.Type;

export const Trace = Schema.Struct({
  baseBranch: Schema.NonEmptyString,
  feature: Slug,
  judgments: Schema.Array(TraceJudgment),
  prd: TraceDocument,
  sections: Schema.Array(Schema.Struct({ id: SectionId, status: SectionStatus })),
  spec: TraceDocument,
  tasks: Schema.Array(TraceTask),
  version: Schema.Literal(1),
  warnings: Schema.Array(TraceWarning),
});
export type Trace = typeof Trace.Type;

export const TraceJson = Schema.fromJsonString(Trace);
