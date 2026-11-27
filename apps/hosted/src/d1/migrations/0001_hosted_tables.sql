-- The hosted service's own tables. Better Auth's tables come from its own schema. A migration is never
-- edited once it lands: a change to the schema is the next numbered file.

create table workspaces (
  id text primary key,
  organization_id text unique not null,
  kind text not null,
  name text not null,
  created_at text not null
);

create table documents (
  id text primary key,
  workspace_id text not null,
  title text not null,
  visibility text not null,
  member_access text not null,
  current_prd text not null,
  current_spec text,
  access_epoch integer not null default 0,
  created_by text not null,
  created_at text not null,
  updated_at text not null
);

create table document_grants (
  document_id text,
  user_id text,
  access text not null,
  granted_by text not null,
  at text not null,
  primary key (document_id, user_id)
);

create table document_invitations (
  id text primary key,
  workspace_id text not null,
  document_id text not null,
  email text not null,
  access text not null,
  token_hash text unique not null,
  invited_by text not null,
  expires_at text not null,
  status text not null,
  accepted_by text
);

create table agents (
  id text primary key,
  workspace_id text not null,
  name text not null,
  for_user text not null,
  scope text not null,
  token_hash text not null,
  created_at text not null,
  last_used_at text,
  revoked_at text
);

create table connections (
  document_id text primary key,
  remote_url text,
  connected_by text not null,
  at text not null
);

create table usage (
  workspace_id text primary key,
  members integer not null,
  prds integer not null,
  private_prds integer not null,
  public_prds integer not null
);

create table pending_revocations (
  id text primary key,
  document_ids text not null,
  principals text not null,
  epoch integer not null,
  created_at text not null,
  attempts integer not null default 0
);
