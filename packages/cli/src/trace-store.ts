import { SessionId, TaskId } from "@cairn/contract";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import {
  Context,
  DateTime,
  Effect,
  ErrorReporter,
  Layer,
  Path,
  Schema,
  String,
  Struct,
} from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/http";
import { Model } from "effect/schema";
import { SqlClient, SqlSchema } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { MainCheckout } from "./main-checkout.ts";
import { migration as init } from "./migrations/0001_init.ts";

/**
 * Text SQLite can hold. It stores UTF-8, where a lone surrogate becomes U+FFFD, so a string with
 * one would not come back as it went in; the store refuses it instead.
 */
const Text = Schema.String.check(
  Schema.makeFilter((text: string) =>
    String.isWellFormed(text) ? undefined : "text with a lone surrogate cannot be stored as UTF-8",
  ),
);

/** How many secrets of each kind redaction replaced in a session's log. */
const Redactions = Schema.Record(Text, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

/**
 * A `sessions` row, declared once: its redacted log and what is known of the run that wrote it.
 * `redactions` is JSON text in the row and an object in memory, and `storedAt` is stamped by the store,
 * so a session handed to it has none. Column names are camelCase through the client's name
 * transforms. Sessions are never updated.
 */
const Sessions = Model.Struct({
  agent: Schema.NullOr(Text),
  endedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  id: SessionId,
  log: Text,
  model: Schema.NullOr(Text),
  redactions: Model.JsonFromString(Redactions),
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  storedAt: Model.GeneratedByApp(Schema.DateTimeUtcFromString),
  taskId: TaskId,
});

/** A session to store, as a caller hands it to `put`: Model's `jsonCreate` variant. */
export const SessionRecord = Model.extract(Sessions, "jsonCreate");
export type SessionRecord = typeof SessionRecord.Type;

/** A session as the store gives it back: the record and when it was stored. */
export const StoredSession = Model.extract(Sessions, "json");
export type StoredSession = typeof StoredSession.Type;

/** The row `put` inserts and the row `get` selects. */
const SessionInsert = Model.extract(Sessions, "insert");
const SessionRow = Model.extract(Sessions, "select");

/**
 * No session with this id is stored. Served, it is a `404` with its message, an answer the sessions
 * route owes, so the server does not report it.
 */
export class SessionNotFound
  extends Schema.TaggedError<SessionNotFound, { readonly brand: unique symbol }>()(
    "SessionNotFound",
    { id: SessionId },
  )
  implements HttpServerRespondable.Respondable
{
  override get message() {
    return `No session ${this.id} in cairn.db`;
  }

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.text(this.message, { status: 404 }));
  }

  override readonly [ErrorReporter.ignore] = true;
}

/** Why the store could not answer: SQLite failed, or a row does not decode. */
export type TraceStoreError = SqlError | Schema.SchemaError;

/**
 * The SQLite client the store runs on. Columns are snake_case in SQL and camelCase in rows. WAL
 * and a five-second busy timeout are the client's defaults, so parallel tasks can store at once.
 */
export const sqliteClient = (filename: string) =>
  SqliteClient.layer({
    filename,
    transformQueryNames: String.camelToSnake,
    transformResultNames: String.snakeToCamel,
  });

/** Runs the migrations that have not run yet. Listed here, so a bundled CLI scans no directory. */
const migrations = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord({ "0001_init": init }),
});

/** Stores redacted sessions in `.cairn/cairn.db` and reads them back by id. */
export class TraceStore extends Context.Service<
  TraceStore,
  {
    /** Stores a session, stamped with the current time. An id already stored fails, as does text with a lone surrogate. */
    readonly put: (session: SessionRecord) => Effect.Effect<void, TraceStoreError>;
    /** The stored session with this id. */
    readonly get: (
      id: SessionId,
    ) => Effect.Effect<StoredSession, SessionNotFound | TraceStoreError>;
  }
>()("@cairn/cli/TraceStore") {
  /** The store on whichever `SqlClient` the environment provides, after its migrations run. */
  static readonly layerSql = Layer.effect(
    TraceStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const insert = SqlSchema.void({
        Request: SessionInsert,
        execute: (row) => sql`insert into sessions ${sql.insert(row)}`,
      });

      const select = SqlSchema.findOneOption({
        Request: SessionId,
        Result: SessionRow,
        execute: (id) => sql`select * from sessions where id = ${id}`,
      });

      const put = Effect.fn("TraceStore.put")(function* (session: SessionRecord) {
        const storedAt = yield* DateTime.now;
        yield* insert(Struct.assign(session, { storedAt }));
      });

      const get = Effect.fn("TraceStore.get")(function* (id: SessionId) {
        const row = yield* select(id);
        return yield* Effect.fromOption(row).pipe(
          Effect.mapError(() => new SessionNotFound({ id })),
        );
      });

      return TraceStore.of({ get, put });
    }),
  ).pipe(Layer.provide(migrations));

  /** The store on a SQLite file, or on `:memory:`. */
  static readonly layerAt = (filename: string) =>
    TraceStore.layerSql.pipe(Layer.provide(sqliteClient(filename)));

  /** A fresh in-memory store, for tests. */
  static readonly layerMemory = TraceStore.layerAt(":memory:");

  /** The store on `.cairn/cairn.db` in the main checkout, which every worktree shares. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const checkout = yield* MainCheckout;
      const path = yield* Path.Path;
      const root = yield* checkout.root;
      return TraceStore.layerAt(path.join(root, ".cairn", "cairn.db"));
    }),
  );
}
