import { HttpApi, HttpApiMiddleware } from "effect/http-api";

import { InvalidInput } from "./errors.ts";

/**
 * Answers a request whose path, query, headers or body does not decode with `InvalidInput` naming the
 * field, in place of the `HttpApi`'s empty `400`. The Worker provides it once, where the API is built.
 */
export class DecodeFailures extends HttpApiMiddleware.Service<DecodeFailures>()(
  "@cairn/contract/hosted/DecodeFailures",
  { error: InvalidInput },
) {}

/**
 * The hosted Worker's API. Each group joins with `.add` before `.middleware(DecodeFailures)`: a middleware
 * reaches only the endpoints already in the API.
 */
export const HostedApi = HttpApi.make("hosted").middleware(DecodeFailures);
