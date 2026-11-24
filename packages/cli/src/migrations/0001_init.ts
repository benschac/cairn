import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Creates `sessions`: one row per stored session, its log already redacted. A landed migration is
 * never edited; a change is a new migration.
 */
export const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    create table sessions (
      id text primary key,
      task_id text not null,
      agent text,
      model text,
      started_at text,
      ended_at text,
      log text not null,
      redactions text not null,
      stored_at text not null
    )
  `;
});
