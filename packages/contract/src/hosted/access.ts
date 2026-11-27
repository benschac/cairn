import { Array, Option, Schema } from "effect";
import { VariantSchema } from "effect/schema";

import { Sha256Hex } from "../judgments.ts";
import { AgentId, DocumentId, InvitationId, UserId, WorkspaceId } from "./ids.ts";

/** What a person may do with a document, from least to most. */
export const Access = Schema.Literals(["read", "comment", "edit", "manage"]);
export type Access = typeof Access.Type;

/** What every workspace member has on a document. */
export const MemberAccess = Schema.Literals(["none", "read", "comment", "edit"]);
export type MemberAccess = typeof MemberAccess.Type;

/** A place in `Access`'s order; `none` is below all of them. */
const rank = (access: Access | "none"): number =>
  Option.getOrElse(
    Array.findFirstIndex(Access.literals, (each) => each === access),
    () => -1,
  );

/** Whether `have` is `need` or more, in the order of `Access`. `none` is never enough. */
export const atLeast = (have: Access | "none", need: Access): boolean => rank(have) >= rank(need);

/** A person's access to one document, given beyond what the workspace gives. */
export const Grant = Schema.Struct({
  access: Access,
  at: Schema.DateTimeUtcFromString,
  documentId: DocumentId,
  grantedBy: UserId,
  userId: UserId,
});
export type Grant = typeof Grant.Type;

export const InvitationStatus = Schema.Literals(["pending", "accepted", "revoked", "expired"]);
export type InvitationStatus = typeof InvitationStatus.Type;

/** An invitation to a workspace, with a role, or to one document, with at most the right to comment. */
export const Invitation = Schema.Union([
  Schema.Struct({
    email: Schema.NonEmptyString,
    expiresAt: Schema.DateTimeUtcFromString,
    id: InvitationId,
    invitedBy: UserId,
    kind: Schema.Literal("workspace"),
    role: Schema.Literals(["admin", "member"]),
    status: InvitationStatus,
    workspaceId: WorkspaceId,
  }),
  Schema.Struct({
    access: Schema.Literals(["read", "comment"]),
    documentId: DocumentId,
    email: Schema.NonEmptyString,
    expiresAt: Schema.DateTimeUtcFromString,
    id: InvitationId,
    invitedBy: UserId,
    kind: Schema.Literal("document"),
    status: InvitationStatus,
    workspaceId: WorkspaceId,
  }),
]);
export type Invitation = typeof Invitation.Type;

/** The documents an agent may reach and what it may do there. */
export const AgentScope = Schema.Struct({
  actions: Schema.NonEmptyArray(Schema.Literals(["read", "progress", "comment"])),
  documents: Schema.NonEmptyArray(DocumentId),
});
export type AgentScope = typeof AgentScope.Type;

/**
 * An agent, declared once: `agent`, the default, is what the API returns, and `row` is what the
 * store keeps, with the hash of the agent's secret. No variant the API returns has the hash.
 */
const AgentVariants = VariantSchema.make({ defaultVariant: "agent", variants: ["agent", "row"] });

/** A field the store keeps and no API response carries. */
const stored = AgentVariants.FieldOnly(["row"]);

export const AgentFields = AgentVariants.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  for: UserId,
  id: AgentId,
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  name: Schema.NonEmptyString,
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  scope: AgentScope,
  secretHash: stored(Sha256Hex),
  workspaceId: WorkspaceId,
});

export const Agent = AgentVariants.extract(AgentFields, "agent");
export type Agent = typeof Agent.Type;

export const AgentRow = AgentVariants.extract(AgentFields, "row");
export type AgentRow = typeof AgentRow.Type;
