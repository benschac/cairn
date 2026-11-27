import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import {
  Array,
  Cause,
  Context,
  Effect,
  ErrorReporter,
  FileSystem,
  Layer,
  Logger,
  Path,
  Schema,
  Scope,
  String,
  Struct,
} from "effect";
import { HttpClient, HttpRouter, HttpServerRespondable } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Manifest, Session, SessionId, TaskId, TraceJson } from "@cairn/contract";
import { ApiRoutes, GitFailed, MalformedParams, Repository, RevisionUnknown } from "../src/api.ts";
import { Git } from "../src/git.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { ReportedFailures } from "../src/serve.ts";
import { TraceStore } from "../src/trace-store.ts";
import { Recorder } from "./fixtures/recorder.ts";

const ZEROS = String.repeat(40)("0");

const git = Effect.fn("git")(function* (directory: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const identity = Array.appendAll(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com"],
    args,
  );
  const out = yield* spawner.string(ChildProcess.make("git", identity, { cwd: directory }));
  return String.trim(out);
});

// A temporary repository with two commits.
const TempRepository = Layer.effect(
  Repository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* git(directory, ["init", "--quiet"]);
    yield* fs.writeFileString(path.join(directory, "a.txt"), "one\n");
    yield* git(directory, ["add", "."]);
    yield* git(directory, ["commit", "--quiet", "-m", "First commit"]);
    yield* fs.writeFileString(path.join(directory, "a.txt"), "one\ntwo\n");
    yield* git(directory, ["commit", "--quiet", "-am", "Second commit"]);
    return Repository.of({ directory });
  }),
);

const CAIRN_FILES = ["prd.md", "spec.md", "manifest.json"];

// A main checkout whose `.cairn/` holds copies of this repository's PRD, spec and manifest.
const TempWorkspace = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* path.fromFileUrl(new URL("../../../.cairn/", import.meta.url));
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, ".cairn"));
    yield* Effect.forEach(CAIRN_FILES, (name) =>
      fs.copyFile(path.join(source, name), path.join(root, ".cairn", name)),
    );
    return MainCheckout.fixed(root);
  }),
);

/** Each cause the server logged as an error, printed. */
class Logged extends Recorder<Logged, string>()("@cairn/cli/test/Logged") {}

// The server's reporter, logging into `Logged` instead of the console.
const Reporting = ReportedFailures.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const logged = yield* Logged;
        const context = yield* Effect.context<Scope.Scope>();
        const run = Effect.runSyncWith(Context.omit(Scope.Scope)(context));
        return Logger.layer([
          Logger.make(({ cause, logLevel }) =>
            logLevel === "Error" ? run(logged.record(Cause.pretty(cause))) : undefined,
          ),
        ]);
      }),
    ),
  ),
);

const Server = HttpRouter.serve(ApiRoutes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provide(Reporting),
  Layer.provide(Layer.mergeAll(TempWorkspace, Git.memory(), TraceStore.layerMemory)),
  Layer.provideMerge(TraceStore.layerMemory),
  Layer.provideMerge(TempWorkspace),
  Layer.provide(TempRepository),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(TempRepository),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Logged.layer),
);

/** `request`'s result, and what the server reported while it ran. */
const reportedDuring = Effect.fn("reportedDuring")(function* <A, E, R>(
  request: Effect.Effect<A, E, R>,
) {
  const logged = yield* Logged;
  const before = yield* logged.seen;
  const result = yield* request;
  const after = yield* logged.seen;
  return { reported: Array.drop(after, Array.length(before)), result };
});

const revisions = Effect.gen(function* () {
  const { directory } = yield* Repository;
  const base = yield* git(directory, ["rev-parse", "HEAD~1"]);
  const head = yield* git(directory, ["rev-parse", "HEAD"]);
  return { base, head };
});

const get = Effect.fn("get")(function* (url: string) {
  const response = yield* HttpClient.get(url);
  return { response, text: yield* response.text };
});

layer(Server)("patch routes", (it) => {
  it.effect("a commit's route returns its message and patch, cached for good", () =>
    Effect.gen(function* () {
      const { head } = yield* revisions;
      const { response, text } = yield* get(`/api/commits/${head}`);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.headers["cache-control"]).toBe("max-age=31536000, immutable");
      expect(text).toContain("Second commit");
      expect(text).not.toContain("First commit");
      expect(text).toContain("+two");
    }),
  );

  it.effect("a range's route returns the change between the commits as one patch", () =>
    Effect.gen(function* () {
      const { base, head } = yield* revisions;
      const { response, text } = yield* get(`/api/diffs/${base}/${head}`);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("max-age=31536000, immutable");
      expect(text).toContain("diff --git a/a.txt b/a.txt");
      expect(text).toContain("+two");
      expect(text).not.toContain("Second commit");
      const reversed = yield* get(`/api/diffs/${head}/${base}`);
      expect(reversed.text).toContain("-two");
    }),
  );

  it.effect("a malformed SHA is 400, never reaches git and is not reported", () =>
    Effect.gen(function* () {
      const { reported, result } = yield* reportedDuring(
        Effect.forEach(
          [
            "/api/commits/abc123",
            `/api/commits/${String.repeat(40)("A")}`,
            "/api/commits/--output=x",
            `/api/diffs/${ZEROS}/HEAD`,
          ],
          get,
        ),
      );
      expect(Array.map(result, ({ response }) => response.status)).toEqual([400, 400, 400, 400]);
      expect(reported).toEqual([]);
    }),
  );

  it.effect(
    "a SHA git does not know is 404 with git's message, for a commit and either end of a range",
    () =>
      Effect.gen(function* () {
        const { head } = yield* revisions;
        const { reported, result } = yield* reportedDuring(
          Effect.forEach(
            [`/api/commits/${ZEROS}`, `/api/diffs/${head}/${ZEROS}`, `/api/diffs/${ZEROS}/${head}`],
            get,
          ),
        );
        expect(Array.map(result, ({ response }) => response.status)).toEqual([404, 404, 404]);
        expect(result[0]?.text).toContain(ZEROS);
        expect(result[0]?.response.headers["cache-control"]).toBeUndefined();
        expect(reported).toEqual([]);
      }),
  );

  it.effect("the routes' failures render themselves, and only git's 500 is reported", () =>
    Effect.gen(function* () {
      const failures = [
        new MalformedParams({ issue: "Expected a SHA" }),
        new RevisionUnknown({ stderr: "fatal: bad object" }),
        new GitFailed({ exitCode: 128, stderr: "fatal: not a git repository" }),
      ];
      const responses = yield* Effect.forEach(failures, HttpServerRespondable.toResponse);
      expect(Array.map(responses, ({ status }) => status)).toEqual([400, 404, 500]);
      expect(Array.map(failures, ErrorReporter.isIgnored)).toEqual([true, true, false]);
    }),
  );
});

const cairnFile = Effect.fn("cairnFile")(function* (name: string) {
  const path = yield* Path.Path;
  const root = yield* (yield* MainCheckout).root;
  return path.join(root, ".cairn", name);
});

const getWith = Effect.fn("getWith")(function* (headers: Record<string, string>) {
  const response = yield* HttpClient.get("/api/trace", { headers });
  return { response, text: yield* response.text };
});

layer(Server)("trace route", (it) => {
  it.effect("returns the Trace as JSON with a quoted ETag", () =>
    Effect.gen(function* () {
      const { response, text } = yield* getWith({});
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/u);
      const trace = yield* Schema.decodeEffect(TraceJson)(text);
      const fs = yield* FileSystem.FileSystem;
      const manifestFile = yield* cairnFile("manifest.json");
      const manifestText = yield* fs.readFileString(manifestFile);
      const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(manifestText);
      expect(trace.feature).toBe(manifest.feature);
      expect(Array.length(trace.tasks)).toBe(Array.length(manifest.tasks));
      expect(trace.judgments).toEqual([]);
    }),
  );

  it.effect("answers a matching If-None-Match with 304 and no body, in any form", () =>
    Effect.gen(function* () {
      const etag = (yield* getWith({})).response.headers["etag"] ?? "";
      const forms = [etag, `W/${etag}`, "*", `"other", ${etag}`];
      const answers = yield* Effect.forEach(forms, (form) => getWith({ "if-none-match": form }));
      expect(Array.map(answers, ({ response }) => response.status)).toEqual([304, 304, 304, 304]);
      expect(Array.map(answers, ({ text }) => text)).toEqual(["", "", "", ""]);
      expect(answers[0]?.response.headers["etag"]).toBe(etag);
    }),
  );

  it.effect("sends the Trace again for a tag that does not match", () =>
    Effect.gen(function* () {
      const { response, text } = yield* getWith({ "if-none-match": '"stale"' });
      expect(response.status).toBe(200);
      expect(text).not.toBe("");
    }),
  );

  it.effect(
    "a changed input changes the ETag, and the old tag is answered with the new Trace",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const prd = yield* cairnFile("prd.md");
        const original = yield* fs.readFileString(prd);
        const before = (yield* getWith({})).response.headers["etag"] ?? "";
        yield* fs.writeFileString(prd, `${original}\nAn edit.\n`);
        const after = yield* getWith({ "if-none-match": before });
        yield* fs.writeFileString(prd, original);
        expect(after.response.status).toBe(200);
        expect(after.response.headers["etag"]).not.toBe(before);
        expect(after.text).toContain("An edit.");
        const restored = yield* getWith({ "if-none-match": before });
        expect(restored.response.status).toBe(304);
      }),
  );

  it.effect("a missing file is a 500 that the server reports, naming the file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spec = yield* cairnFile("spec.md");
      const original = yield* fs.readFileString(spec);
      yield* fs.remove(spec);
      const { reported, result } = yield* reportedDuring(
        getWith({}).pipe(Effect.ensuring(Effect.orDie(fs.writeFileString(spec, original)))),
      );
      expect(result.response.status).toBe(500);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("spec.md does not exist");
    }),
  );
});

const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A Claude Code log of one prompt and the reply to it. */
const LOG = Array.join(
  [
    encodeLine({
      message: { content: "Add the store", role: "user" },
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "user",
      uuid: "u1",
    }),
    encodeLine({
      message: { content: [{ text: "Added it.", type: "text" }], role: "assistant" },
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "assistant",
      uuid: "a1",
    }),
  ],
  "\n",
);

const sessionId = Schema.decodeSync(SessionId);
const T1 = Schema.decodeSync(TaskId)("t1");

layer(Server)("session route", (it) => {
  it.effect(
    "returns a stored session read into turns, with its redaction counts and no notes",
    () =>
      Effect.gen(function* () {
        const store = yield* TraceStore;
        yield* store.put({
          agent: "claude",
          endedAt: null,
          id: sessionId("s_stored1"),
          log: LOG,
          model: null,
          redactions: { "github-token": 2 },
          startedAt: null,
          taskId: T1,
        });
        const { response, text } = yield* get("/api/sessions/s_stored1");
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("application/json");
        const session = yield* Schema.decodeEffect(Schema.fromJsonString(Session))(text);
        expect(session).toMatchObject({
          format: "claude-code",
          id: "s_stored1",
          notes: [],
          redactions: { "github-token": 2 },
          skipped: 0,
          taskId: "t1",
        });
        expect(Array.map(session.turns, ({ kind }) => kind)).toEqual(["prompt", "reply"]);
      }),
  );

  it.effect(
    "an id the store does not hold is 404, one that is not a session id is 400, and neither is reported",
    () =>
      Effect.gen(function* () {
        const { reported, result } = yield* reportedDuring(
          Effect.forEach(["/api/sessions/s_missing1", "/api/sessions/not-a-session"], get),
        );
        const [unknown, malformed] = result;
        expect([unknown?.response.status, malformed?.response.status]).toEqual([404, 400]);
        expect(unknown?.text).toContain("s_missing1");
        expect(reported).toEqual([]);
      }),
  );
});

const NOTE = {
  anchor: "/task/t1",
  author: "agent:t1",
  body: "Check the empty case.",
  kind: "review",
  label: null,
  resolvedAt: null,
  status: "open",
  task: T1,
} as const;

layer(Server)("notes", (it) => {
  it.effect("the Trace carries the stored notes, and a new note changes its ETag", () =>
    Effect.gen(function* () {
      const store = yield* TraceStore;
      const before = (yield* getWith({})).response.headers["etag"] ?? "";
      const note = yield* store.addNote(Struct.assign(NOTE, { session: null }));
      const { response, text } = yield* getWith({ "if-none-match": before });
      const trace = yield* Schema.decodeEffect(TraceJson)(text);
      expect(response.status).toBe(200);
      expect(response.headers["etag"]).not.toBe(before);
      expect(trace.notes).toEqual([note]);
    }),
  );

  it.effect("a session carries the notes that hang off it and no others", () =>
    Effect.gen(function* () {
      const store = yield* TraceStore;
      yield* store.put({
        agent: null,
        endedAt: null,
        id: sessionId("s_noted01"),
        log: LOG,
        model: null,
        redactions: {},
        startedAt: null,
        taskId: T1,
      });
      const own = yield* store.addNote(Struct.assign(NOTE, { session: sessionId("s_noted01") }));
      yield* store.addNote(Struct.assign(NOTE, { session: sessionId("s_other01") }));
      const { text } = yield* get("/api/sessions/s_noted01");
      const session = yield* Schema.decodeEffect(Schema.fromJsonString(Session))(text);
      expect(session.notes).toEqual([own]);
    }),
  );
});
