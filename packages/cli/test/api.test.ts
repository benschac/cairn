import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Array, Effect, FileSystem, Layer, Path, String } from "effect";
import { HttpClient, HttpRouter } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ApiRoutes, Repository } from "../src/api.ts";

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

const Server = HttpRouter.serve(ApiRoutes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provide(TempRepository),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(TempRepository),
  Layer.provideMerge(NodeServices.layer),
);

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

  it.effect("a malformed SHA is 400 and never reaches git", () =>
    Effect.gen(function* () {
      const short = yield* get("/api/commits/abc123");
      const upper = yield* get(`/api/commits/${String.repeat(40)("A")}`);
      const option = yield* get("/api/commits/--output=x");
      const range = yield* get(`/api/diffs/${ZEROS}/HEAD`);
      expect(Array.map([short, upper, option, range], ({ response }) => response.status)).toEqual([
        400, 400, 400, 400,
      ]);
    }),
  );

  it.effect("a SHA git does not know is 404, for a commit and for either end of a range", () =>
    Effect.gen(function* () {
      const { head } = yield* revisions;
      const commit = yield* get(`/api/commits/${ZEROS}`);
      const end = yield* get(`/api/diffs/${head}/${ZEROS}`);
      const start = yield* get(`/api/diffs/${ZEROS}/${head}`);
      expect(Array.map([commit, end, start], ({ response }) => response.status)).toEqual([
        404, 404, 404,
      ]);
      expect(commit.response.headers["cache-control"]).toBeUndefined();
    }),
  );
});
