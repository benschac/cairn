import { env } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/http";

import type { WorkerEnv } from "../alchemy.run.ts";
import { HostedEnv } from "./env.ts";
import { ReportedFailures } from "./http/reported-failures.ts";
import { Routes } from "./http/routes.ts";

// The runtime calls `fetch` and `scheduled` outside any fiber. Their services are built once per
// isolate, from the bindings, at module scope: a fiber started inside `fetch` would keep that
// request's async context (see `HttpRouter.toWebHandler`). Both handlers share one build through the
// memo map, and neither context holds the build's `Scope`: each request and each cron tick runs in a
// scope of its own, released when it ends.
const services = Layer.merge(HostedEnv.layer(env), ReportedFailures);
const memoMap = Layer.makeMemoMapUnsafe();
const web = HttpRouter.toWebHandler(Routes.pipe(Layer.provide(services)), { memoMap });
const runtime = ManagedRuntime.make(services, { memoMap });

/** What the cron trigger runs every minute. The retry of failed room calls joins it (spec.hosted-launch.room). */
const tick = Effect.void;

export default {
  fetch: (request) => web.handler(request),
  scheduled: (_controller, _env, context) => {
    context.waitUntil(runtime.runPromise(Effect.scoped(tick)));
  },
} satisfies ExportedHandler<WorkerEnv>;
