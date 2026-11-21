import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";

import { PresenceRoute, Room } from "./presence.ts";

HttpRouter.serve(PresenceRoute).pipe(
  Layer.provide(Room.layer),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 4310 })),
  Layer.launch,
  NodeRuntime.runMain,
);
