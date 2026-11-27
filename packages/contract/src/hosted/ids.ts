import { Array, Effect, Option, Schema } from "effect";

import { Sha256Hex } from "../judgments.ts";

/** The length of the random part of an ID. */
const RANDOM_LENGTH = 12;

const ALPHABET = Array.fromIterable("abcdefghijklmnopqrstuvwxyz0123456789");

/** The largest multiple of the alphabet's size in a byte: a byte at or above it is dropped, so each character is equally likely. */
const UNBIASED = 252;

/**
 * Twelve characters of `[a-z0-9]` from `crypto.getRandomValues`. A byte that would favour the first
 * characters is dropped, and the draw is repeated in the rare case that too few bytes are left.
 */
const randomPart = (): string => {
  const kept = Array.getSomes(
    Array.map(
      Array.fromIterable(crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH * 4))),
      (byte) =>
        byte < UNBIASED ? Array.get(ALPHABET, byte % Array.length(ALPHABET)) : Option.none(),
    ),
  );
  return Array.length(kept) < RANDOM_LENGTH
    ? randomPart()
    : Array.join(Array.take(kept, RANDOM_LENGTH), "");
};

const idPattern = (prefix: string) => new RegExp(`^${prefix}_[a-z0-9]{${RANDOM_LENGTH}}$`, "u");

/** A new ID under `prefix`: `w_` and twelve random characters. */
export const randomId = (prefix: string): string => `${prefix}_${randomPart()}`;

export const WorkspaceId = Schema.String.check(Schema.isPattern(idPattern("w"))).pipe(
  Schema.brand("WorkspaceId"),
);
export type WorkspaceId = typeof WorkspaceId.Type;

export const DocumentId = Schema.String.check(Schema.isPattern(idPattern("doc"))).pipe(
  Schema.brand("DocumentId"),
);
export type DocumentId = typeof DocumentId.Type;

export const RevisionId = Schema.String.check(Schema.isPattern(idPattern("rev"))).pipe(
  Schema.brand("RevisionId"),
);
export type RevisionId = typeof RevisionId.Type;

export const AgentId = Schema.String.check(Schema.isPattern(idPattern("agt"))).pipe(
  Schema.brand("AgentId"),
);
export type AgentId = typeof AgentId.Type;

export const InvitationId = Schema.String.check(Schema.isPattern(idPattern("inv"))).pipe(
  Schema.brand("InvitationId"),
);
export type InvitationId = typeof InvitationId.Type;

export const PlanRecordId = Schema.String.check(Schema.isPattern(idPattern("plan"))).pipe(
  Schema.brand("PlanRecordId"),
);
export type PlanRecordId = typeof PlanRecordId.Type;

/** The SHA-256 of an `events.jsonl` line's bytes. */
export const EventId = Sha256Hex;
export type EventId = typeof EventId.Type;

/** Better Auth's user ID. */
export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

/** A fresh ID of each kind. */
export const newId = {
  agent: Effect.sync(() => AgentId.make(randomId("agt"))),
  document: Effect.sync(() => DocumentId.make(randomId("doc"))),
  invitation: Effect.sync(() => InvitationId.make(randomId("inv"))),
  planRecord: Effect.sync(() => PlanRecordId.make(randomId("plan"))),
  revision: Effect.sync(() => RevisionId.make(randomId("rev"))),
  workspace: Effect.sync(() => WorkspaceId.make(randomId("w"))),
};

/** Who acts: a person, an agent acting for one, or someone not signed in. */
export const Principal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), userId: UserId }),
  Schema.Struct({ agentId: AgentId, for: UserId, kind: Schema.Literal("agent") }),
  Schema.Struct({ kind: Schema.Literal("anonymous") }),
]);
export type Principal = typeof Principal.Type;

/** A principal and the name shown for it; an agent shows "<agent name> for <person>". */
export const Author = Schema.Struct({ name: Schema.String, principal: Principal });
export type Author = typeof Author.Type;
