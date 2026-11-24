import { Config as CairnConfig } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import {
  Array,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";
import { Decision, DecisionModel } from "effect/ai";
import { Headers, HttpClient, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";

import { ModelKeyError, TYPESAFE_API_KEY, decisionModel } from "../src/models.ts";

/**
 * Nothing here reads a real key or touches the network. Configuration comes from a
 * `ConfigProvider` built from a record, and TypeSafe's host is a stub `HttpClient`.
 */
const FAKE_KEY = "test-key";

class Wire extends Context.Service<
  Wire,
  { readonly requests: Effect.Effect<ReadonlyArray<HttpClientRequest.HttpClientRequest>> }
>()("@cairn/cli/test/models/Wire") {}

/** An `HttpClient` that records each request and answers it with a TypeSafe answer. */
const wire = Layer.unwrap(
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
    const client = HttpClient.make((request) =>
      Ref.update(seen, Array.append(request)).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              answers: { urgent: { noul: 0.9, type: "noul" } },
              model: "jev-1.14.0",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          ),
        ),
      ),
    );
    return Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, client),
      Layer.succeed(Wire, Wire.of({ requests: Ref.get(seen) })),
    );
  }),
);

const environment = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(env));

const configOf = Schema.decodeSync(CairnConfig);

const definition = Decision.make({
  decisions: { urgent: Decision.probability({ instructions: "The message is time-sensitive" }) },
  input: Schema.Struct({ text: Schema.String }),
});

const SentBody = Schema.fromJsonString(Schema.Struct({ model: Schema.String }));

const decide = DecisionModel.decide(definition, { input: { text: "now" } });

/** A decision made through `config`'s layer, and the one request it sent. */
const decided = (config: CairnConfig) =>
  Effect.gen(function* () {
    const response = yield* decide.pipe(
      Effect.provide(
        decisionModel(config).pipe(Layer.provide(environment({ [TYPESAFE_API_KEY]: FAKE_KEY }))),
      ),
    );
    const wired = yield* Wire;
    const [request] = yield* wired.requests;
    if (Predicate.isUndefined(request) || !Predicate.isTagged("Uint8Array")(request.body)) {
      return yield* Effect.die("the stub saw no request body");
    }
    const body = yield* Schema.decodeEffect(SentBody)(new TextDecoder().decode(request.body.body));
    return {
      key: Headers.get(request.headers, "authorization"),
      model: body.model,
      probability: response.answers.urgent.probability,
      url: request.url,
    };
  }).pipe(Effect.provide(wire));

it.effect(
  "the Judge's model is jev-1.14.0 by default, sent to TypeSafe with the key as a bearer token",
  () =>
    Effect.gen(function* () {
      const seen = yield* decided(configOf({}));
      expect(seen.model).toBe("jev-1.14.0");
      expect(seen.url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(seen.key).toEqual(Option.some(`Bearer ${FAKE_KEY}`));
      expect(seen.probability).toBeCloseTo(0.9);
    }),
);

it.effect.prop(
  "judge.model and judge.baseUrl are sent as written",
  [
    Schema.Literals(["jev-1.13.0", "jev-preview"]),
    Schema.Literals(["https://gateway.test/ts", "http://localhost:9"]),
  ],
  ([model, baseUrl]) =>
    Effect.gen(function* () {
      const seen = yield* decided(configOf({ judge: { baseUrl, model } }));
      expect(seen.model).toBe(model);
      expect(seen.url).toBe(`${baseUrl}/systemone`);
    }),
);

it.effect(
  "a missing or empty key fails the layer with a ModelKeyError that names TYPESAFE_API_KEY",
  () =>
    Effect.gen(function* () {
      const config = configOf({});
      yield* Effect.forEach([{}, { [TYPESAFE_API_KEY]: "" }], (env) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            Layer.build(decisionModel(config).pipe(Layer.provide(environment(env)))).pipe(
              Effect.scoped,
            ),
          );
          expect(Schema.is(ModelKeyError)(failure)).toBe(true);
          expect(failure.message).toContain("TYPESAFE_API_KEY");
        }),
      );
    }).pipe(Effect.provide(wire)),
);

it.effect("making the layer reads no key and sends nothing", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make<ReadonlyArray<ConfigProvider.Path>>([]);
    const base = ConfigProvider.fromEnvRecord({ [TYPESAFE_API_KEY]: FAKE_KEY });
    const provider = ConfigProvider.layer(
      ConfigProvider.make((path) =>
        Ref.update(reads, Array.append(path)).pipe(Effect.andThen(base.load(path))),
      ),
    );
    decisionModel(configOf({})).pipe(Layer.provide(provider));
    const wired = yield* Wire;
    const read = yield* Ref.get(reads);
    const sent = yield* wired.requests;
    expect(read).toEqual([]);
    expect(sent).toEqual([]);
  }).pipe(Effect.provide(wire)),
);
