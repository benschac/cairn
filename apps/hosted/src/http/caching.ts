import { Effect } from "effect";
import { Headers, HttpEffect, HttpRouter, HttpServerResponse } from "effect/http";

/**
 * `Cache-Control: no-store` on every response that does not set its own, failures included, so no
 * shared cache holds document content. A public response sets `no-cache` and an `ETag` itself.
 */
export const NoStore = HttpRouter.middleware(
  (effect) =>
    HttpEffect.withPreResponseHandler(effect, (_request, response) =>
      Effect.succeed(
        Headers.has(response.headers, "cache-control")
          ? response
          : HttpServerResponse.setHeader(response, "cache-control", "no-store"),
      ),
    ),
  { global: true },
);
