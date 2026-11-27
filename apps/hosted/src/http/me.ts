import { CurrentUser, HostedApi, MyWorkspace, SharedDocument } from "@cairn/contract/hosted";
import { D1Client } from "@effect/sql-d1";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { AccountSettings, planOf } from "../auth.ts";

/**
 * `GET /api/me`: the user; their workspaces, each with role and kind; and the documents they hold
 * grants on in workspaces they are not a member of, each with its workspace's name and nothing else
 * about that workspace.
 */
export const MeLive = HttpApiBuilder.group(HostedApi, "me", (handlers) =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const settings = yield* AccountSettings;
    return handlers.handle("me", () =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        const memberships = yield* sql<{
          readonly id: string;
          readonly kind: string;
          readonly name: string;
          readonly created_at: string;
          readonly role: string;
        }>`
        select w.id, w.kind, w.name, w.created_at, m.role
        from member m join workspaces w on w.organization_id = m.organizationId
        where m.userId = ${user.id}
        order by w.created_at, w.id`;
        const grants = yield* sql<{
          readonly id: string;
          readonly title: string;
          readonly access: string;
          readonly workspace_name: string;
        }>`
        select d.id, d.title, g.access, w.name as workspace_name
        from document_grants g
          join documents d on d.id = g.document_id
          join workspaces w on w.id = d.workspace_id
        where g.user_id = ${user.id}
          and not exists (
            select 1 from member m where m.organizationId = w.organization_id and m.userId = g.user_id
          )
        order by d.title, d.id`;
        const plan = planOf(settings.billing);
        return {
          sharedWithMe: yield* Effect.forEach(grants, (row) =>
            Schema.decodeUnknownEffect(SharedDocument)({
              access: row.access,
              id: row.id,
              title: row.title,
              workspaceName: row.workspace_name,
            }),
          ),
          user,
          workspaces: yield* Effect.forEach(memberships, (row) =>
            Schema.decodeUnknownEffect(MyWorkspace)({
              createdAt: row.created_at,
              id: row.id,
              kind: row.kind,
              name: row.name,
              plan,
              role: row.role,
            }),
          ),
        };
      }).pipe(Effect.orDie),
    );
  }),
);
