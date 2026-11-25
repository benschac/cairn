import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { HttpClient, HttpRouter } from "effect/http";

import { Repository } from "../src/api.ts";
import { Git } from "../src/git.ts";
import { MainCheckout } from "../src/main-checkout.ts";
import { Room } from "../src/presence.ts";
import { Routes, ViewerDirectory } from "../src/serve.ts";
import { TraceStore } from "../src/trace-store.ts";

const INDEX = "<!doctype html><title>viewer</title>";
const ASSET = "console.log('asset');";

// A viewer build with an index and one script, so no real build is needed.
const TempViewer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(directory, "assets"));
    yield* fs.writeFileString(path.join(directory, "index.html"), INDEX);
    yield* fs.writeFileString(path.join(directory, "assets", "app.js"), ASSET);
    return ViewerDirectory.at(directory);
  }),
);

const CAIRN_FILES = ["prd.md", "spec.md", "manifest.json"];

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

const Server = HttpRouter.serve(Routes, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provide(
    Layer.mergeAll(
      TempViewer,
      TempWorkspace,
      Git.memory(),
      TraceStore.layerMemory,
      Room.layer,
      Repository.layer(),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
);

const get = Effect.fn("get")(function* (url: string) {
  const response = yield* HttpClient.get(url);
  return { response, text: yield* response.text };
});

layer(Server)("viewer routes", (it) => {
  it.effect("/ returns index.html", () =>
    Effect.gen(function* () {
      const { response, text } = yield* get("/");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(text).toBe(INDEX);
    }),
  );

  it.effect("a built asset is returned as itself", () =>
    Effect.gen(function* () {
      const { response, text } = yield* get("/assets/app.js");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("javascript");
      expect(text).toBe(ASSET);
    }),
  );

  it.effect("a client-side route and a path out of the directory serve index.html", () =>
    Effect.gen(function* () {
      const route = yield* get("/section/prd.cli/task/t1");
      const escape = yield* get("/..%2f..%2fpackage.json");
      const up = yield* get("/assets/../../../package.json");
      expect([route.response.status, route.text]).toEqual([200, INDEX]);
      expect(escape.text).toBe(INDEX);
      expect(up.text).toBe(INDEX);
    }),
  );

  it.effect("/api keeps its routes, and an unknown API path is 404", () =>
    Effect.gen(function* () {
      const trace = yield* get("/api/trace");
      expect(trace.response.status).toBe(200);
      expect(trace.response.headers["etag"]).toBeDefined();
      expect(trace.text).not.toBe(INDEX);
      const unknown = yield* get("/api/nothing");
      expect(unknown.response.status).toBe(404);
    }),
  );
});
