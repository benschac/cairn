import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * Adds `notes.label`: the judge's label for a note and its probability, as JSON text. A note stored
 * before it has none, which is `null`. A landed migration is never edited.
 */
export const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table notes add column label text`;
});
