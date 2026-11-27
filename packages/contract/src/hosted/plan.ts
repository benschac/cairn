import { Schema } from "effect";

import { Sha256Hex } from "../judgments.ts";
import { TaskId } from "../ids.ts";
import { Sha } from "../trailers.ts";
import { Author, DocumentId, PlanRecordId, RevisionId } from "./ids.ts";

/** A plan uploaded to a document: the manifest's hash and what it was planned from. */
export const PlanRecord = Schema.Struct({
  documentId: DocumentId,
  id: PlanRecordId,
  manifestHash: Sha256Hex,
  source: Schema.Struct({
    prdHash: Schema.NullOr(Sha256Hex),
    prdRevision: Schema.NullOr(RevisionId),
    specRevision: Schema.NullOr(RevisionId),
  }),
  uploadedAt: Schema.DateTimeUtcFromString,
  uploadedBy: Author,
});
export type PlanRecord = typeof PlanRecord.Type;

/** A person's approval of a task's gate, and what they approved it against. */
export const GateApproval = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: Author,
  inputs: Schema.Struct({
    head: Schema.NullOr(Sha),
    plan: PlanRecordId,
    prdRevision: RevisionId,
    specRevision: Schema.NullOr(RevisionId),
  }),
  task: TaskId,
});
export type GateApproval = typeof GateApproval.Type;
