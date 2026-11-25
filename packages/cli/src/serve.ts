import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { ApiRoutes, Repository } from "./api.ts";
import { layer as gitLayer } from "./git-live.ts";
import { MainCheckout } from "./main-checkout.ts";
import { PresenceRoute, Room } from "./presence.ts";
import { TraceStore } from "./trace-store.ts";

const port = Config.Port("CAIRN_PRESENCE_PORT").pipe(Config.withDefault(4310));

HttpRouter.serve(Layer.merge(PresenceRoute, ApiRoutes)).pipe(
  Layer.provide(Room.layer),
  Layer.provide(Repository.layer()),
  Layer.provide(TraceStore.layer),
  Layer.provide(Layer.merge(gitLayer(), MainCheckout.layer())),
  Layer.provide(NodeServices.layer),
  Layer.provide(NodeHttpServer.layerConfig(createServer, { port })),
  Layer.launch,
  NodeRuntime.runMain,
);
