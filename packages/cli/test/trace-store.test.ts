import { Note, NoteId, NoteRecord, SessionId, TaskId } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, DateTime, Effect, FileSystem, Layer, Path, Schema, String, Struct } from "effect";
import { SqlClient } from "effect/sql";
import { SqlError } from "effect/sql/SqlError";

import {
  NoteNotFound,
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
    expect(migrations).toEqual([
      { migration_id: 1, name: "init" },
      { migration_id: 2, name: "notes" },
      { migration_id: 3, name: "note_labels" },
    ]);
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
      store.put(Struct.assign(session, { log: globalThis.String.fromCharCode(0xd800) })),
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

const byId = (notes: ReadonlyArray<Note>) => Array.sortWith(notes, ({ id }) => id, String.Order);

it.effect.prop(
  "every added note comes back from notes as addNote returned it, with a fresh id and the time",
  [Schema.Array(NoteRecord)],
  ([records]) =>
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const added = yield* Effect.forEach(records, store.addNote);
      const read = yield* store.notes;
      const now = yield* DateTime.now;
      // JSON stores a probability of -0 as 0. Both represent the same probability.
      expect(Schema.toEquivalence(Schema.Array(Note))(byId(read), byId(added))).toBe(true);
      expect(added).toEqual(
        Array.zipWith(records, added, (record, { id }) => Struct.assign(record, { at: now, id })),
      );
      expect(Array.length(Array.dedupe(Array.map(added, ({ id }) => id)))).toBe(
        Array.length(records),
      );
    }).pipe(Effect.provide(TraceStore.layerMemory)),
);

const review = NoteRecord.make({
  anchor: "/task/t2/diff/0000000000000000000000000000000000000000/file/src%2Fstore.ts/lines/n40",
  author: "agent:t2",
  body: "This reads the **old** column.",
  kind: "review",
  label: null,
  resolvedAt: null,
  session: SessionId.make("s_abc123"),
  status: "open",
  task: TaskId.make("t2"),
});

it("only the store writes a note's id and time", () => {
  expect(Array.difference(Struct.keys(Note.fields), Struct.keys(NoteRecord.fields))).toEqual([
    "at",
    "id",
  ]);
});

it.effect("resolving a note sets its status and when, and changes nothing else", () =>
  Effect.gen(function* () {
    const store = yield* TraceStore;
    const added = yield* store.addNote(review);
    const resolved = yield* store.resolveNote(added.id);
    const again = yield* store.resolveNote(added.id);
    const now = yield* DateTime.now;
    expect(resolved).toEqual(Struct.assign(added, { resolvedAt: now, status: "resolved" }));
    const read = yield* store.notes;
    expect(again).toEqual(resolved);
    expect(read).toEqual([resolved]);
  }).pipe(Effect.provide(TraceStore.layerMemory)),
);

it.effect("resolving a note that was never stored is NoteNotFound", () =>
  Effect.gen(function* () {
    const store = yield* TraceStore;
    yield* store.addNote(review);
    const id = NoteId.make("n_missing0");
    const error = yield* Effect.flip(store.resolveNote(id));
    expect(error).toEqual(new NoteNotFound({ id }));
  }).pipe(Effect.provide(TraceStore.layerMemory)),
);

it.effect("the notes row holds its times as ISO strings and an unresolved note's as null", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* TraceStore;
    const { id } = yield* store.addNote(review);
    const rows = yield* sql`select id, at, resolved_at, task, session from notes`.withoutTransform;
    expect(rows).toEqual([
      { at: "1970-01-01T00:00:00.000Z", id, resolved_at: null, session: "s_abc123", task: "t2" },
    ]);
    expect(id).toMatch(/^n_[a-z0-9]{12}$/u);
  }).pipe(Effect.provide(TraceStore.layerSql.pipe(Layer.provideMerge(sqliteClient(":memory:"))))),
);
