import { Schema } from "effect";

import { UserId, WorkspaceId } from "./ids.ts";

export const Workspace = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  id: WorkspaceId,
  kind: Schema.Literals(["personal", "team"]),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
});
export type Workspace = typeof Workspace.Type;

export const Role = Schema.Literals(["owner", "admin", "member"]);
export type Role = typeof Role.Type;

export const Member = Schema.Struct({
  email: Schema.NonEmptyString,
  joinedAt: Schema.DateTimeUtcFromString,
  name: Schema.String,
  role: Role,
  userId: UserId,
  workspaceId: WorkspaceId,
});
export type Member = typeof Member.Type;
