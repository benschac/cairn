import { Array, Context, Effect, Layer, Ref } from "effect";
import { HttpClient } from "effect/http";
import type { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

/** How a recording `HttpClient` answers a request. */
export type Answer = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

/** What a recording `HttpClient` saw, in order. */
export class Wire extends Context.Service<
  Wire,
  { readonly requests: Effect.Effect<ReadonlyArray<HttpClientRequest.HttpClientRequest>> }
>()("@cairn/cli/test/Wire") {
  /** An `HttpClient` that never touches the network: it records each request and answers it with `answer`. */
  static readonly layer = (answer: Answer) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
        const client = HttpClient.make((request) =>
          Ref.update(seen, Array.append(request)).pipe(Effect.andThen(answer(request))),
        );
        return Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.succeed(Wire, Wire.of({ requests: Ref.get(seen) })),
        );
      }),
    );
}
