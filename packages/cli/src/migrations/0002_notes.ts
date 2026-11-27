import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Creates `notes`: one row per note or review, anchored by a link path. A note hangs off a session
 * when it has one, and never off a commit. A landed migration is never edited.
 */
export const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    create table notes (
      id text primary key,
      kind text not null,
      author text not null,
      body text not null,
      status text not null,
      anchor text not null,
      task text,
      session text,
      at text not null,
      resolved_at text
    )
  `;
});
