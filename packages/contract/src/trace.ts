import { Effect, Schema } from "effect";

import { Event } from "./events.ts";
import { PrdSectionId, SectionId, SpecSectionId, StatementId, TaskId, TestId } from "./ids.ts";
import { Judgment } from "./judgments.ts";
import { HumanGate, ManifestTask, SectionStatus, Slug } from "./manifest.ts";
import { Note } from "./note.ts";
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

const emptyArray = Effect.succeed([]);

/** A list item that carries an id, such as `prd.cli.lint` on a bullet. */
export const TraceItem = Schema.Struct({
  human: Schema.Boolean,
  id: SectionId,
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The item it is nested in, or else the heading. */
  parent: SectionId,
  /** The heading it sits under. */
  section: SectionId,
  /** The item's own text, without its `{#id}`. */
  text: Schema.String,
});
export type TraceItem = typeof TraceItem.Type;

/** A done-when statement in the PRD. */
export const TraceStatement = Schema.Struct({
  draft: Schema.Boolean,
  human: Schema.Boolean,
  id: StatementId,
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  owner: PrdSectionId,
  provedBy: Schema.Array(TestId),
  /** Without `Draft:`, the human tag or the `{#id}`. */
  text: Schema.String,
});
export type TraceStatement = typeof TraceStatement.Type;

export const TraceDocument = Schema.Struct({
  /** Document order; empty in a trace written before items existed. */
  items: Schema.Array(TraceItem).pipe(Schema.withDecodingDefaultKey(emptyArray)),
  markdown: Schema.String,
  path: Schema.String,
  sections: Schema.Array(TraceSection),
  /** Document order; always empty for the spec. */
  statements: Schema.Array(TraceStatement).pipe(Schema.withDecodingDefaultKey(emptyArray)),
});
export type TraceDocument = typeof TraceDocument.Type;

export const TraceCommit = Schema.Struct({
  files: Schema.Array(Schema.String),
  parents: Schema.Array(Sha),
  sections: Schema.Array(Schema.Union([PrdSectionId, SpecSectionId])),
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
    /** The statements the task is to prove; empty in a trace written before statements existed. */
    statements: Schema.Array(StatementId).pipe(Schema.withDecodingDefaultKey(emptyArray)),
    waiting: Schema.Boolean,
    /**
     * A pending task whose every needed task is `done` or `landed`, as the relation index says
     * (see `spec.status.answers-from-the-index`); false in a trace written before it was carried.
     */
    canStart: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    /** The unfinished tasks it needs directly, in id order. */
    waitsOn: Schema.Array(TaskId).pipe(Schema.withDecodingDefaultKey(emptyArray)),
    /** The unfinished tasks that need it directly, in id order. */
    waitedOnBy: Schema.Array(TaskId).pipe(Schema.withDecodingDefaultKey(emptyArray)),
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
  /** The notes in `cairn.db`, oldest first; empty in a trace written before notes existed. */
  notes: Schema.Array(Note).pipe(Schema.withDecodingDefaultKey(emptyArray)),
  prd: TraceDocument,
  sections: Schema.Array(Schema.Struct({ id: SectionId, status: SectionStatus })),
  spec: TraceDocument,
  tasks: Schema.Array(TraceTask),
  version: Schema.Literal(1),
  warnings: Schema.Array(TraceWarning),
});
export type Trace = typeof Trace.Type;

export const TraceJson = Schema.fromJsonString(Trace);
