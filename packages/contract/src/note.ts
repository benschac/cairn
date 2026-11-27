import { Schema, String } from "effect";
import { Model } from "effect/schema";

import { TaskId } from "./ids.ts";
import { NoteId } from "./link.ts";
import { SessionId } from "./trailers.ts";

/**
 * Text SQLite can hold. It stores UTF-8, where a lone surrogate becomes U+FFFD, so a string with one
 * would not come back as it went in; `cairn.db` refuses it instead.
 */
export const WellFormedText = Schema.String.check(
  Schema.makeFilter((text: string) =>
    String.isWellFormed(text) ? undefined : "text with a lone surrogate cannot be stored as UTF-8",
  ),
);

export const NoteKind = Schema.Literals(["note", "review"]);
export type NoteKind = typeof NoteKind.Type;

export const NoteStatus = Schema.Literals(["open", "resolved"]);
export type NoteStatus = typeof NoteStatus.Type;

/**
 * A note, declared once: what `cairn note add` hands the store, the `notes` row in `cairn.db` and
 * the note the trace and a session carry (see `spec.sessions.notes`). The store gives `id` and
 * `at`, so a note handed to it has neither. Column names are snake_case through the client's name
 * transforms.
 */
export const Notes = Model.Struct({
  /** A link path (see `spec.contract.links`): what the note is about. */
  anchor: WellFormedText,
  at: Model.GeneratedByApp(Schema.DateTimeUtcFromString),
  /** Who wrote it: `agent:t2`, `human:Ada`, `orchestrator`. */
  author: WellFormedText,
  /** Markdown. */
  body: WellFormedText,
  id: Model.GeneratedByApp(NoteId),
  kind: NoteKind,
  resolvedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  /** The session the note hangs off, when there is one. A note never hangs off a commit. */
  session: Schema.NullOr(SessionId),
  status: NoteStatus,
  task: Schema.NullOr(TaskId),
});

/** A note as the trace and a session carry it: Model's `json` variant. */
export const Note = Model.extract(Notes, "json");
export type Note = typeof Note.Type;

/** A note to store, as `cairn note add` hands it to the store: Model's `jsonCreate` variant. */
export const NoteRecord = Model.extract(Notes, "jsonCreate");
export type NoteRecord = typeof NoteRecord.Type;
