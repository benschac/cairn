import { SessionId, TaskId } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, DateTime, Effect, FileSystem, Layer, Path, Schema, Struct } from "effect";
import { SqlClient } from "effect/sql";
import { SqlError } from "effect/sql/SqlError";

import {
  SessionNotFound,
  SessionRecord,
  StoredSession,
  sqliteClient,
  TraceStore,
} from "../src/trace-store.ts";

/** The store keys sessions by id, so generated sessions keep the first of each id. */
const distinct = (sessions: ReadonlyArray<SessionRecord>) =>
  Array.dedupeWith(sessions, (a, b) => a.id === b.id);

it.effect.prop(
  "every stored session comes back as it went in, stamped with when it was stored",
  [Schema.Array(SessionRecord)],
  ([generated]) =>
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const sessions = distinct(generated);
      yield* Effect.forEach(sessions, store.put);
      const storedAt = yield* DateTime.now;
      const read = yield* Effect.forEach(sessions, ({ id }) => store.get(id));
      expect(read).toEqual(Array.map(sessions, Struct.assign({ storedAt })));
    }).pipe(Effect.provide(TraceStore.layerMemory)),
);

it.effect.prop(
  "an id that was never stored is SessionNotFound",
  [Schema.Array(SessionRecord), SessionId],
  ([generated, id]) =>
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const others = Array.filter(distinct(generated), (session) => session.id !== id);
      yield* Effect.forEach(others, store.put);
      const error = yield* Effect.flip(store.get(id));
      expect(error).toEqual(new SessionNotFound({ id }));
    }).pipe(Effect.provide(TraceStore.layerMemory)),
);

const session = SessionRecord.make({
  agent: "claude",
  endedAt: DateTime.makeUnsafe("2026-11-24T10:05:00.000Z"),
  id: SessionId.make("s_abc123"),
  log: '{"type":"user","message":"[REDACTED:anthropic]"}\n',
  model: "claude-opus-5-5",
  redactions: { anthropic: 1 },
  startedAt: DateTime.makeUnsafe("2026-11-24T10:00:00.000Z"),
  taskId: TaskId.make("t2"),
});

it.effect("a database file keeps its sessions, and its migration runs once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const filename = path.join(directory, "cairn.db");
    const put = Effect.gen(function* () {
      const store = yield* TraceStore;
      yield* store.put(session);
    });
    const get = Effect.gen(function* () {
      const store = yield* TraceStore;
      return yield* store.get(session.id);
    });

    yield* put.pipe(Effect.provide(TraceStore.layerAt(filename)));
    const read = yield* get.pipe(Effect.provide(TraceStore.layerAt(filename)));
    const migrations = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`select migration_id, name from effect_sql_migrations`.withoutTransform;
    }).pipe(Effect.provide(sqliteClient(filename)));

    expect(read).toEqual(Struct.assign(session, { storedAt: DateTime.makeUnsafe(0) }));
    expect(migrations).toEqual([{ migration_id: 1, name: "init" }]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a row that does not decode is a SchemaError, not a session", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* TraceStore;
    yield* sql`insert into sessions ${sql.insert({
      id: "s_badrow",
      log: "",
      redactions: "{}",
      storedAt: "1970-01-01T00:00:00.000Z",
      taskId: "not a task id",
    })}`;
    const error = yield* Effect.flip(store.get(SessionId.make("s_badrow")));
    expect(error).toBeInstanceOf(Schema.SchemaError);
  }).pipe(Effect.provide(TraceStore.layerSql.pipe(Layer.provideMerge(sqliteClient(":memory:"))))),
);

it.effect("text with a lone surrogate is refused, not stored changed", () =>
  Effect.gen(function* () {
    const store = yield* TraceStore;
    const error = yield* Effect.flip(
      store.put(Struct.assign(session, { log: String.fromCharCode(0xd800) })),
    );
    const missing = yield* Effect.flip(store.get(session.id));
    expect(error).toBeInstanceOf(Schema.SchemaError);
    expect(missing).toEqual(new SessionNotFound({ id: session.id }));
  }).pipe(Effect.provide(TraceStore.layerMemory)),
);

it.effect("storing an id twice fails and keeps the first session", () =>
  Effect.gen(function* () {
    const store = yield* TraceStore;
    yield* store.put(session);
    const error = yield* Effect.flip(store.put(Struct.assign(session, { log: "" })));
    const read = yield* store.get(session.id);
    expect(error).toBeInstanceOf(SqlError);
    expect(read.log).toBe(session.log);
  }).pipe(Effect.provide(TraceStore.layerMemory)),
);

it("only the store writes storedAt", () => {
  expect(
    Array.difference(Struct.keys(StoredSession.fields), Struct.keys(SessionRecord.fields)),
  ).toEqual(["storedAt"]);
});

it.effect("the row holds redactions as JSON text and storedAt as an ISO string", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* TraceStore;
    yield* store.put(session);
    const rows = yield* sql`select redactions, stored_at from sessions`.withoutTransform;
    expect(rows).toEqual([
      { redactions: '{"anthropic":1}', stored_at: "1970-01-01T00:00:00.000Z" },
    ]);
  }).pipe(Effect.provide(TraceStore.layerSql.pipe(Layer.provideMerge(sqliteClient(":memory:"))))),
);
