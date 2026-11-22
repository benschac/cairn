import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { PresenceRoute, Room } from "./presence.ts";

const port = Config.Port("CAIRN_PRESENCE_PORT").pipe(Config.withDefault(4310));

HttpRouter.serve(PresenceRoute).pipe(
  Layer.provide(Room.layer),
  Layer.provide(NodeHttpServer.layerConfig(createServer, { port })),
  Layer.launch,
  NodeRuntime.runMain,
);
