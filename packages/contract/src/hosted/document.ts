import { Schema } from "effect";
import { VariantSchema } from "effect/schema";

import { Access, MemberAccess } from "./access.ts";
import { DocumentId, RevisionId, UserId, WorkspaceId } from "./ids.ts";

/**
 * A document, declared once: `document`, the default, is the record, and `view` is what
 * `GET /api/documents/:id` returns: the record with the caller's access, the current markdown and
 * whether a plan has been uploaded.
 */
const DocumentVariants = VariantSchema.make({
  defaultVariant: "document",
  variants: ["document", "view"],
});

/** A field the reader's view adds to the record. */
const viewed = DocumentVariants.FieldOnly(["view"]);

export const DocumentFields = DocumentVariants.Struct({
  access: viewed(Access),
  createdAt: Schema.DateTimeUtcFromString,
  createdBy: UserId,
  current: Schema.Struct({ prd: RevisionId, spec: Schema.NullOr(RevisionId) }),
  hasPlan: viewed(Schema.Boolean),
  id: DocumentId,
  markdown: viewed(Schema.String),
  /** What every workspace member has; a new document gives `edit`. */
  memberAccess: MemberAccess,
  /** Metadata, independent of the markdown's own heading. */
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  updatedAt: Schema.DateTimeUtcFromString,
  visibility: Schema.Literals(["private", "public"]),
  workspaceId: WorkspaceId,
});

export const Document = DocumentVariants.extract(DocumentFields, "document");
export type Document = typeof Document.Type;

export const DocumentView = DocumentVariants.extract(DocumentFields, "view");
export type DocumentView = typeof DocumentView.Type;
