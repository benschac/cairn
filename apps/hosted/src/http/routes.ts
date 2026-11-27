import { HostedApi, NotFound } from "@cairn/contract/hosted";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { NoStore } from "./caching.ts";
import { DecodeFailuresLive } from "./decode-failures.ts";

/** Any method on a path under `/api/` that no route claims: `NotFound`, in the error shape. */
export const UnknownApiRoute = HttpRouter.add(
  "*",
  "/api/*",
  Effect.fail(new NotFound({ message: "No such route." })),
);

/**
 * The Worker's routes around an `HttpApi` built with `HttpApiBuilder`: the catch-all under `/api/`, and
 * `no-store` on every response. Better Auth's handler and the viewer's static-asset fallback join
 * here as plain routes beside the API.
 */
export const routesFor = <E, R>(api: Layer.Layer<never, E, R>) =>
  Layer.mergeAll(api, UnknownApiRoute, NoStore).pipe(
    Layer.provide(DecodeFailuresLive),
    Layer.provide(HttpServer.layerServices),
  );

/** The hosted API's routes. */
export const Routes = routesFor(HttpApiBuilder.layer(HostedApi));
