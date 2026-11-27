import { Schema } from "effect";
import { VariantSchema } from "effect/schema";

import { Sha256Hex } from "../judgments.ts";
import { Author, DocumentId, RevisionId } from "./ids.ts";

/** A content revision is not a file format's `version` field: the two are never compared. */
export const RevisionKind = Schema.Literals(["prd", "spec"]);
export type RevisionKind = typeof RevisionKind.Type;

/**
 * A revision, declared once. `revision`, the default, is the record; `body` adds the markdown;
 * `save` is what a client sends to make one, where the server sets everything else.
 */
const RevisionVariants = VariantSchema.make({
  defaultVariant: "revision",
  variants: ["revision", "body", "save"],
});

/** A field the server sets, so no request decodes it. */
const bySaver = RevisionVariants.FieldExcept(["save"]);

export const RevisionFields = RevisionVariants.Struct({
  author: bySaver(Author),
  at: bySaver(Schema.DateTimeUtcFromString),
  /** The revision the save was made from; `null` is only for a document's first spec revision. */
  base: RevisionVariants.FieldOnly(["save"])(Schema.NullOr(RevisionId)),
  bytes: bySaver(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  clientId: RevisionVariants.FieldOnly(["save"])(Schema.NonEmptyString),
  documentId: bySaver(DocumentId),
  /** Of the stored markdown's UTF-8 bytes. */
  hash: bySaver(Sha256Hex),
  id: bySaver(RevisionId),
  kind: RevisionKind,
  markdown: RevisionVariants.FieldOnly(["body", "save"])(Schema.String),
  /** 1, 2, ... per document and kind. */
  number: bySaver(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  parent: bySaver(Schema.NullOr(RevisionId)),
  restoredFrom: bySaver(Schema.NullOr(RevisionId)),
});

export const Revision = RevisionVariants.extract(RevisionFields, "revision");
export type Revision = typeof Revision.Type;

export const RevisionBody = RevisionVariants.extract(RevisionFields, "body");
export type RevisionBody = typeof RevisionBody.Type;

export const SaveInput = RevisionVariants.extract(RevisionFields, "save");
export type SaveInput = typeof SaveInput.Type;
