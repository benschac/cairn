import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import type { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { Recorder } from "./recorder.ts";

/** How a recording `HttpClient` answers a request. */
export type Answer = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

/** The requests a recording `HttpClient` was sent, in order. */
export class Wire extends Recorder<Wire, HttpClientRequest.HttpClientRequest>()(
  "@cairn/cli/test/Wire",
) {
  /** An `HttpClient` that never touches the network: it records each request and answers it with `answer`. */
  static readonly client = (answer: Answer): Layer.Layer<HttpClient.HttpClient | Wire> =>
    Layer.effect(
      HttpClient.HttpClient,
      Effect.map(Wire, (wire) =>
        HttpClient.make((request) => wire.record(request).pipe(Effect.andThen(answer(request)))),
      ),
    ).pipe(Layer.provideMerge(Wire.layer));
}
