import { Schema } from "effect";
import { VariantSchema } from "effect/schema";

import { SectionId } from "../ids.ts";
import { NoteId, Quote } from "../link.ts";
import { RevisionKind } from "./revision.ts";
import { Author, DocumentId, RevisionId } from "./ids.ts";

/** What a comment is about: a section or a passage of one revision of a document. */
export const Anchor = Schema.Struct({
  document: DocumentId,
  on: RevisionKind,
  /** A passage, as in `spec.contract.links`. */
  quote: Schema.NullOr(Quote),
  /** The revision the author was reading. */
  revision: RevisionId,
  /** `null` is the whole document. */
  section: Schema.NullOr(SectionId),
});
export type Anchor = typeof Anchor.Type;

/**
 * A comment, declared once. `comment`, the default, is what the room keeps; `create` is what a
 * request sends to make one and `edit` to change one. The server sets `id`, `thread`, `author`,
 * `at` and `editedAt`, so no request decodes them. `version` is in the edit request, where it names
 * the version the edit was based on, and in the stored comment, where the room sets it.
 */
const CommentVariants = VariantSchema.make({
  defaultVariant: "comment",
  variants: ["comment", "create", "edit"],
});

/** A field only the room sets. */
const byRoom = CommentVariants.FieldOnly(["comment"]);

export const CommentFields = CommentVariants.Struct({
  at: byRoom(Schema.DateTimeUtcFromString),
  author: byRoom(Author),
  /** Markdown. */
  body: Schema.String.check(Schema.isMaxLength(20_000)),
  editedAt: byRoom(Schema.NullOr(Schema.DateTimeUtcFromString)),
  id: byRoom(NoteId),
  thread: byRoom(NoteId),
  version: CommentVariants.FieldOnly(["comment", "edit"])(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
});

export const Comment = CommentVariants.extract(CommentFields, "comment");
export type Comment = typeof Comment.Type;

export const CommentCreate = CommentVariants.extract(CommentFields, "create");
export type CommentCreate = typeof CommentCreate.Type;

export const CommentEdit = CommentVariants.extract(CommentFields, "edit");
export type CommentEdit = typeof CommentEdit.Type;

/** A thread of comments. Its root comment's ID is the thread's ID. */
export const Thread = Schema.Struct({
  anchor: Anchor,
  comments: Schema.NonEmptyArray(Comment),
  resolvedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  resolvedBy: Schema.NullOr(Author),
  root: NoteId,
  status: Schema.Literals(["open", "resolved"]),
});
export type Thread = typeof Thread.Type;

/** Whether a thread's anchor still holds in the document's current revision. */
export const AnchorState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("attached") }),
  Schema.Struct({
    /** `null` for a reader who may not open that revision. */
    original: Schema.NullOr(
      Schema.Struct({ quote: Schema.NullOr(Quote), sectionTitle: Schema.String }),
    ),
    reason: Schema.Literals(["section-missing", "passage-changed"]),
    state: Schema.Literal("changed"),
  }),
]);
export type AnchorState = typeof AnchorState.Type;

export const ThreadView = Thread.pipe(Schema.fieldsAssign({ anchorState: AnchorState }));
export type ThreadView = typeof ThreadView.Type;
