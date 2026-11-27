import { HostedApi, NotFound } from "@cairn/contract/hosted";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Auth, AuthenticationLive, AuthRoutes } from "../auth.ts";
import { NoStore } from "./caching.ts";
import { DecodeFailuresLive } from "./decode-failures.ts";
import { MeLive } from "./me.ts";
import { WorkspacesLive } from "./workspaces.ts";

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

/**
 * The hosted API's routes, and Better Auth's under `/api/auth/`. They need the bindings, the account
 * settings and a `Mailer`, which `worker.ts` provides.
 */
export const Routes = routesFor(
  Layer.merge(
    HttpApiBuilder.layer(HostedApi).pipe(
      Layer.provide(Layer.mergeAll(MeLive, WorkspacesLive)),
      Layer.provide(AuthenticationLive),
    ),
    AuthRoutes,
  ),
).pipe(Layer.provide(Auth.layer));
