import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Array, Config, Context, Effect, FileSystem, Layer, Path, String } from "effect";
import { Command } from "effect/cli";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { ApiRoutes, Repository } from "./api.ts";
import { layer as gitLayer } from "./git-live.ts";
import { MainCheckout } from "./main-checkout.ts";
import { PresenceRoute, Room } from "./presence.ts";
import { TraceStore } from "./trace-store.ts";

const port = Config.Port("CAIRN_PRESENCE_PORT").pipe(Config.withDefault(4310));

/** The directory of the built viewer. A directory other than `apps/viewer/dist` lets a test serve a temporary one. */
export class ViewerDirectory extends Context.Service<
  ViewerDirectory,
  { readonly directory: string }
>()("@cairn/cli/ViewerDirectory") {
  /** The viewer's build output in this repository. */
  static readonly built = Layer.effect(
    ViewerDirectory,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = yield* path.fromFileUrl(
        new URL("../../../apps/viewer/dist/", import.meta.url),
      );
      return ViewerDirectory.of({ directory });
    }),
  );

  /** The viewer's files in `directory`. */
  static readonly at = (directory: string) =>
    Layer.succeed(ViewerDirectory, ViewerDirectory.of({ directory }));
}

/** Prefixes that belong to the server's own routes: an unknown path under one is a 404, not the viewer. */
const SERVER_PREFIXES = ["/api/", "/presence/"];

/**
 * `GET /*`: the file of the built viewer at the path, or `index.html` for any other path so a
 * client-side route survives a reload. A path that leaves the directory gets `index.html` too.
 */
export const ViewerRoutes = HttpRouter.add("GET", "/*", (request) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { directory } = yield* ViewerDirectory;
    const { pathname } = new URL(request.url, "http://localhost");
    if (Array.some(SERVER_PREFIXES, (prefix) => String.startsWith(prefix)(pathname))) {
      return HttpServerResponse.empty({ status: 404 });
    }
    const requested = path.join(directory, path.normalize(pathname));
    const isFile = yield* fs.stat(requested).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    return yield* HttpServerResponse.file(isFile ? requested : path.join(directory, "index.html"));
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 }))),
);

/** Every route: presence, the API and the viewer. */
export const Routes = Layer.mergeAll(PresenceRoute, ApiRoutes, ViewerRoutes);

/** The server on `CAIRN_PRESENCE_PORT` (default 4310), serving the built viewer. */
export const server = HttpRouter.serve(Routes).pipe(
  Layer.provide(Room.layer),
  Layer.provide(Repository.layer()),
  Layer.provide(TraceStore.layer),
  Layer.provide(Layer.merge(gitLayer(), MainCheckout.layer())),
  Layer.provide(ViewerDirectory.built),
  Layer.provide(NodeHttpServer.layerConfig(createServer, { port })),
);

/** `cairn serve`: runs until interrupted. */
export const serveCommand = Command.make("serve", {}, () => Layer.launch(server)).pipe(
  Command.withDescription("Serve the viewer, the trace API and presence"),
);
