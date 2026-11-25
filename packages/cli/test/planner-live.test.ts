import { Config as CairnConfig, defaultConfig } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Record,
  Ref,
  Schema,
  String,
  Struct,
} from "effect";
import { LanguageModel } from "effect/ai";
import { Headers, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";
import { systemError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CliNotFound } from "../src/cli-model.ts";
import {
  ANTHROPIC_API_KEY,
  DEFAULT_KEY_VARIABLES,
  ModelKeyError,
  ModelUnavailable,
  PlannerCall,
  languageModel,
  languageModelFor,
  modelNameFor,
  plannerKeyVariable,
} from "../src/models.ts";
import { Planner, PlannerError, PromptError, fillPrompt, loadPrompts } from "../src/planner.ts";
import { scripted } from "./fixtures/scripted-language-model.ts";

/**
 * Nothing here reads a real key or touches the network. The configuration of every test comes from
 * a `ConfigProvider` built from a record, never from the process environment, so the suite behaves
 * the same whether or not `ANTHROPIC_API_KEY` is set in the shell that runs it. The key is an
 * obviously fake value, and the model's host is a stub `HttpClient`.
 */
const FAKE_KEY = "test-key";

/** What a stub `HttpClient` saw. */
class Wire extends Context.Service<
  Wire,
  { readonly requests: Effect.Effect<ReadonlyArray<HttpClientRequest.HttpClientRequest>> }
>()("@cairn/cli/test/Wire") {}

type Answer = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

/** An `HttpClient` that records each request and answers it with `answer`. */
const wire = (answer: Answer) =>
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

const CANNED = "A canned reply";

/** What Anthropic answers a message request with. */
const message = (text: string) =>
  Response.json({
    content: [{ text, type: "text" }],
    id: "msg_test",
    model: "test-model",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

const replies: Answer = (request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, message(CANNED)));

/** A provider that refuses the key: the status Anthropic answers with for a key it does not know. */
const unauthorized: Answer = (request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json(
        { error: { message: "invalid x-api-key", type: "authentication_error" }, type: "error" },
        { status: 401 },
      ),
    ),
  );

/** A transport failure, which carries the request that failed, headers and all. */
const unreachable: Answer = (request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ description: "connection refused", request }),
    }),
  );

/** A provider that answers like the environment would, from a record. */
const environment = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(env));

const withKey = environment({ [ANTHROPIC_API_KEY]: FAKE_KEY });

/** A config for the `api` source with the Anthropic provider, which `planner` fields refine. */
const configOf = (planner: {
  readonly baseUrl?: string;
  readonly keyEnv?: string;
  readonly model?: string;
  readonly small?: string;
}) =>
  Schema.decodeSync(CairnConfig)({
    planner: Struct.assign(planner, { provider: "anthropic" as const, source: "api" as const }),
  });

const apiConfig = configOf({ model: "test-model" });

/** Only the failure of one type: an error of another type is a defect in the test. */
const only =
  <T>(is: (input: unknown) => input is T) =>
  (error: unknown) =>
    is(error) ? Effect.succeed(error) : Effect.die(error);

/** The live planner of `config`: its model layer over a stub client, and the prompt files on disk. */
const livePlanner = (config: CairnConfig, env: Layer.Layer<never>, answer: Answer) =>
  Planner.layerWith(config).pipe(
    Layer.provide(languageModel(config).pipe(Layer.provide(env))),
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(wire(answer)),
  );

const spec = (prd: string) => Planner.use((planner) => planner.spec(prd));

/** What the planner's one request said: where it went, what it named and how it signed in. */
const SentModel = Schema.fromJsonString(Schema.Struct({ model: Schema.String }));

const sent = Effect.gen(function* () {
  const wired = yield* Wire;
  const [request] = yield* wired.requests;
  if (Predicate.isUndefined(request)) {
    return yield* Effect.die("the stub saw no request");
  }
  const body = Predicate.isTagged("Uint8Array")(request.body)
    ? yield* Schema.decodeEffect(SentModel)(new TextDecoder().decode(request.body.body))
    : { model: "" };
  return {
    key: Headers.get(request.headers, "x-api-key"),
    model: body.model,
    url: request.url,
  };
});

it.effect("a missing key fails the layer with a ModelKeyError that names ANTHROPIC_API_KEY", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      Layer.build(languageModel(apiConfig).pipe(Layer.provide(environment({})))).pipe(
        Effect.scoped,
      ),
    ).pipe(Effect.flatMap(only(Schema.is(ModelKeyError))));
    expect(failure.variable).toBe("ANTHROPIC_API_KEY");
    expect(failure.message).toContain("ANTHROPIC_API_KEY");
    expect(failure.toString()).toContain("ANTHROPIC_API_KEY");
  }).pipe(Effect.provide(Layer.mergeAll(wire(replies), NodeServices.layer))),
);

it.effect("a key set to nothing counts as missing", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      Layer.build(
        languageModel(apiConfig).pipe(Layer.provide(environment({ [ANTHROPIC_API_KEY]: "" }))),
      ).pipe(Effect.scoped),
    ).pipe(Effect.flatMap(only(Schema.is(ModelKeyError))));
    expect(failure.variable).toBe("ANTHROPIC_API_KEY");
  }).pipe(Effect.provide(Layer.mergeAll(wire(replies), NodeServices.layer))),
);

it.effect("the key is read when the layer is built, and nothing else is read", () =>
  Effect.gen(function* () {
    const reads = yield* Ref.make<ReadonlyArray<ConfigProvider.Path>>([]);
    const base = ConfigProvider.fromEnvRecord({ [ANTHROPIC_API_KEY]: FAKE_KEY });
    const provider = ConfigProvider.layer(
      ConfigProvider.make((path) =>
        Ref.update(reads, Array.append(path)).pipe(Effect.andThen(base.load(path))),
      ),
    );
    const layer = languageModel(apiConfig).pipe(Layer.provide(provider));
    // Making the layer, and a planner over a model that is not this one, read nothing.
    const beforeBuilding = yield* Ref.get(reads);
    yield* Layer.build(Planner.layer.pipe(Layer.provide(scripted([])))).pipe(Effect.scoped);
    const afterPlanner = yield* Ref.get(reads);
    yield* Layer.build(layer).pipe(Effect.scoped);
    const afterModel = yield* Ref.get(reads);
    expect(beforeBuilding).toEqual([]);
    expect(afterPlanner).toEqual([]);
    expect(afterModel).toEqual([[ANTHROPIC_API_KEY]]);
  }).pipe(Effect.provide(Layer.mergeAll(wire(replies), NodeServices.layer))),
);

const MODEL = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.-]{0,30}$/u));
const GATEWAY = Schema.Literals([
  "https://gateway.test",
  "http://localhost:8787/anthropic",
  "https://gateway.test/v1/acct/gw/anthropic",
]);

it.effect.prop(
  "spec goes to planner.baseUrl, names planner.model, signs in with the key and returns the reply",
  [MODEL, GATEWAY],
  ([model, baseUrl]) =>
    Effect.gen(function* () {
      const written = yield* spec("a prd");
      const request = yield* sent;
      expect(written).toBe(CANNED);
      expect(request.model).toBe(model);
      expect(request.key).toEqual(Option.some(FAKE_KEY));
      expect(String.startsWith(`${baseUrl}/v1/messages`)(request.url)).toBe(true);
    }).pipe(Effect.provide(livePlanner(configOf({ baseUrl, model }), withKey, replies))),
);

it.effect("spec goes to the provider's own host when planner.baseUrl is not set", () =>
  Effect.gen(function* () {
    const written = yield* spec("a prd");
    const request = yield* sent;
    expect(written).toBe(CANNED);
    expect(request.model).toBe("test-model");
    expect(String.startsWith("https://api.anthropic.com/v1/messages")(request.url)).toBe(true);
  }).pipe(Effect.provide(livePlanner(apiConfig, withKey, replies))),
);

it.effect("the prompt the model gets holds the PRD and this repository's spec as its example", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const example = yield* fs.readFileString(
      new URL("../../../.cairn/spec.md", import.meta.url).pathname,
    );
    const prompts = yield* loadPrompts(defaultConfig.judge.models);
    const prompt = yield* prompts.spec("The PRD of a small tool.");
    expect(prompt).toContain("The PRD of a small tool.");
    expect(prompt).toContain(example);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.prop(
  "a failure from the provider is a PlannerError that never holds the key",
  [Schema.Literals(["transport", "unauthorized"])],
  ([failure]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(spec("a prd"));
      expect(Schema.is(PlannerError)(error)).toBe(true);
      expect(error.call).toBe("spec");
      // The request that failed held the key, so this fails if an error repeats the request.
      const request = yield* sent;
      expect(request.key).toEqual(Option.some(FAKE_KEY));
      Array.forEach([error.toString(), error.message, error.reason], (text) =>
        expect(text).not.toContain(FAKE_KEY),
      );
    }).pipe(
      Effect.provide(
        livePlanner(apiConfig, withKey, failure === "transport" ? unreachable : unauthorized),
      ),
    ),
);

it.effect(
  "a model layer built without a key leaves the planner unbuilt, so no request is sent",
  () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Layer.build(livePlanner(apiConfig, environment({}), replies)).pipe(Effect.scoped),
      );
      expect(Schema.is(ModelKeyError)(failure)).toBe(true);
    }),
);

const KEY_VARIABLE = Schema.Literals(["CAIRN_PLANNER_KEY", "MY_PLANNER_TOKEN"]);

it.effect.prop(
  "planner.keyEnv names the variable the key is read from, and no other is tried",
  [KEY_VARIABLE],
  ([variable]) => {
    const config = configOf({ keyEnv: variable, model: "test-model" });
    return Effect.gen(function* () {
      const written = yield* spec("a prd").pipe(
        Effect.provide(livePlanner(config, environment({ [variable]: FAKE_KEY }), replies)),
      );
      expect(written).toBe(CANNED);
      expect(plannerKeyVariable(config)).toEqual(Option.some(variable));

      // The default variable does not stand in for it.
      const failure = yield* Effect.flip(
        Layer.build(
          languageModel(config).pipe(Layer.provide(environment({ [ANTHROPIC_API_KEY]: FAKE_KEY }))),
        ).pipe(Effect.scoped),
      ).pipe(Effect.flatMap(only(Schema.is(ModelKeyError))));
      expect(failure.message).toContain(variable);
      expect(failure.message).not.toContain(ANTHROPIC_API_KEY);
    }).pipe(Effect.provide(Layer.mergeAll(wire(replies), NodeServices.layer)));
  },
);

it.effect("the Redactor is told which variable is read: none for the cli source", () =>
  Effect.sync(() => {
    expect(plannerKeyVariable(defaultConfig)).toEqual(Option.none());
    expect(plannerKeyVariable(apiConfig)).toEqual(Option.some(ANTHROPIC_API_KEY));
  }),
);

/**
 * A spawner that runs nothing: it records the program of each command and answers that it is not
 * on `PATH`, so a test sees which CLI a layer looks for without running one.
 */
const absent = Effect.gen(function* () {
  const programs = yield* Ref.make<ReadonlyArray<string>>([]);
  const spawner = ChildProcessSpawner.make((command) =>
    Ref.update(
      programs,
      Array.append(ChildProcess.isStandardCommand(command) ? command.command : ""),
    ).pipe(
      Effect.andThen(
        Effect.fail(
          systemError({
            _tag: "NotFound",
            description: "no such file or directory",
            method: "spawn",
            module: "ChildProcess",
          }),
        ),
      ),
    ),
  );
  return { programs: Ref.get(programs), spawner };
});

/** A provider that records every path it is asked to read. */
const recording = Effect.gen(function* () {
  const reads = yield* Ref.make<ReadonlyArray<ConfigProvider.Path>>([]);
  const base = ConfigProvider.fromEnvRecord({ [ANTHROPIC_API_KEY]: FAKE_KEY });
  const layer = ConfigProvider.layer(
    ConfigProvider.make((path) =>
      Ref.update(reads, Array.append(path)).pipe(Effect.andThen(base.load(path))),
    ),
  );
  return { layer, reads: Ref.get(reads) };
});

it.effect.prop(
  "a configured agent CLI is looked for when its layer is built, and no key is read",
  [Schema.Literals(["claude", "codex"])],
  ([cli]) => {
    const config = Schema.decodeSync(CairnConfig)({ planner: { cli } });
    return Effect.gen(function* () {
      const none = yield* absent;
      const keys = yield* recording;
      const failure = yield* Effect.flip(
        Layer.build(languageModel(config).pipe(Layer.provide(keys.layer))).pipe(
          Effect.scoped,
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, none.spawner),
        ),
      ).pipe(Effect.flatMap(only(Schema.is(CliNotFound))));
      expect(failure.message).toContain(`${cli} was not found`);
      const programs = yield* none.programs;
      const reads = yield* keys.reads;
      expect(programs).toEqual([cli]);
      expect(reads).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(wire(replies), NodeServices.layer)));
  },
);

it.effect("building no layer looks for no CLI and reads no key", () =>
  Effect.gen(function* () {
    const none = yield* absent;
    const keys = yield* recording;
    // Making the layers is not building them.
    languageModelFor(defaultConfig, "spec").pipe(Layer.provide(keys.layer));
    languageModelFor(apiConfig, "spec").pipe(Layer.provide(keys.layer));
    const programs = yield* none.programs;
    const reads = yield* keys.reads;
    expect(programs).toEqual([]);
    expect(reads).toEqual([]);
  }),
);

/** What each provider's request shows: where it goes, how it signs in and the model it names. */
const Providers = [
  { provider: "openai", variable: "OPENAI_API_KEY" },
  { provider: "openrouter", variable: "OPENROUTER_API_KEY" },
  { provider: "openai-compatible", variable: "OPENAI_COMPATIBLE_API_KEY" },
] as const;

/** An answer no provider can read: the request is what these tests look at. */
const refuses: Answer = (request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}, { status: 500 })));

const providerConfig = (provider: (typeof Providers)[number]["provider"], keyEnv?: string) =>
  Schema.decodeSync(CairnConfig)({
    planner: {
      baseUrl: "https://gateway.test/v1",
      model: "test-model",
      provider,
      source: "api",
      ...(keyEnv === undefined ? {} : { keyEnv }),
    },
  });

/** The one request a provider's planner sent, after its call has failed on the refusal. */
const requestOf = (config: CairnConfig, env: Layer.Layer<never>) =>
  Effect.gen(function* () {
    yield* Effect.ignore(spec("a prd"));
    const wired = yield* Wire;
    const [request] = yield* wired.requests;
    if (Predicate.isUndefined(request)) {
      return yield* Effect.die("the stub saw no request");
    }
    return request;
  }).pipe(Effect.provide(livePlanner(config, env, refuses)));

Array.forEach(Providers, ({ provider, variable }) => {
  it.effect(
    `${provider}: spec goes to planner.baseUrl, names planner.model and signs in with the key`,
    () =>
      Effect.gen(function* () {
        const request = yield* requestOf(
          providerConfig(provider),
          environment({ [variable]: FAKE_KEY }),
        );
        expect(String.startsWith("https://gateway.test/v1/")(request.url)).toBe(true);
        expect(Headers.get(request.headers, "authorization")).toEqual(
          Option.some(`Bearer ${FAKE_KEY}`),
        );
        const body = Predicate.isTagged("Uint8Array")(request.body)
          ? new TextDecoder().decode(request.body.body)
          : "";
        expect(body).toContain('"model":"test-model"');
      }),
  );

  it.effect(`${provider}: planner.keyEnv names the variable the key is read from`, () =>
    Effect.gen(function* () {
      const request = yield* requestOf(
        providerConfig(provider, "MY_KEY"),
        environment({ MY_KEY: FAKE_KEY }),
      );
      expect(Headers.get(request.headers, "authorization")).toEqual(
        Option.some(`Bearer ${FAKE_KEY}`),
      );
    }),
  );
});

/** Every api provider, the Anthropic one included. */
const ApiProvider = Schema.Literals(["anthropic", "openai", "openrouter", "openai-compatible"]);

const GATEWAY_VARIABLE = "CAIRN_AI_GATEWAY_TOKEN";
const GATEWAY_HEADER = "cf-aig-authorization";

/** A token as a gateway issues it: a header value with nothing a stub would have to escape. */
const GatewayToken = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{8,40}$/u));

const gatewayConfig = (provider: typeof ApiProvider.Type, gatewayTokenEnv?: string) =>
  Schema.decodeSync(CairnConfig)({
    planner: {
      baseUrl: "https://gateway.test/v1",
      model: "test-model",
      provider,
      source: "api",
      ...(gatewayTokenEnv === undefined ? {} : { gatewayTokenEnv }),
    },
  });

/** Every request a provider's planner sent, after its call has failed on the refusal. */
const requestsOf = (config: CairnConfig, env: Layer.Layer<never>) =>
  Effect.gen(function* () {
    yield* Effect.ignore(spec("a prd"));
    const wired = yield* Wire;
    return yield* wired.requests;
  }).pipe(Effect.provide(livePlanner(config, env, refuses)));

const keyAndGateway = (variable: string, token: string) =>
  environment({ [variable]: FAKE_KEY, [GATEWAY_VARIABLE]: token });

it.effect.prop(
  "planner.gatewayTokenEnv sends cf-aig-authorization with the token on every request of every api provider",
  [ApiProvider, GatewayToken],
  ([provider, token]) =>
    Effect.gen(function* () {
      const variable = DEFAULT_KEY_VARIABLES[provider];
      const requests = yield* requestsOf(
        gatewayConfig(provider, GATEWAY_VARIABLE),
        keyAndGateway(variable, token),
      );
      expect(Array.isReadonlyArrayNonEmpty(requests)).toBe(true);
      Array.forEach(requests, (request) => {
        expect(Headers.get(request.headers, GATEWAY_HEADER)).toEqual(
          Option.some(`Bearer ${token}`),
        );
      });
    }),
);

it.effect.prop(
  "with planner.gatewayTokenEnv unset no gateway header is sent, though the variable is in the environment",
  [ApiProvider, GatewayToken],
  ([provider, token]) =>
    Effect.gen(function* () {
      const variable = DEFAULT_KEY_VARIABLES[provider];
      const requests = yield* requestsOf(gatewayConfig(provider), keyAndGateway(variable, token));
      expect(Array.isReadonlyArrayNonEmpty(requests)).toBe(true);
      Array.forEach(requests, (request) => {
        expect(Headers.get(request.headers, GATEWAY_HEADER)).toEqual(Option.none());
      });
    }),
);

it.effect.prop(
  "a planner.gatewayTokenEnv variable that is not set fails the layer with a ModelKeyError that names it, before any request",
  [ApiProvider],
  ([provider]) =>
    Effect.gen(function* () {
      const variable = DEFAULT_KEY_VARIABLES[provider];
      const failure = yield* Effect.flip(
        Layer.build(
          languageModel(gatewayConfig(provider, GATEWAY_VARIABLE)).pipe(
            Layer.provide(environment({ [variable]: FAKE_KEY })),
          ),
        ).pipe(Effect.scoped),
      ).pipe(Effect.flatMap(only(Schema.is(ModelKeyError))));
      expect(failure.variable).toBe(GATEWAY_VARIABLE);
      expect(failure.message).toContain(GATEWAY_VARIABLE);
      const wired = yield* Wire;
      const requests = yield* wired.requests;
      expect(requests).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(wire(replies), NodeServices.layer))),
);

it.effect.prop(
  "openai and openrouter fail the layer with a ModelKeyError that names their variable when the key is missing",
  [Schema.Literals(["openai", "openrouter"])],
  ([provider]) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Layer.build(
          languageModel(providerConfig(provider)).pipe(Layer.provide(environment({}))),
        ).pipe(Effect.scoped),
      ).pipe(Effect.flatMap(only(Schema.is(ModelKeyError))));
      expect(failure.variable).toBe(
        provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY",
      );
    }).pipe(Effect.provide(Layer.mergeAll(wire(replies), NodeServices.layer))),
);

it.effect("openai-compatible builds its layer and calls without a key", () =>
  Effect.gen(function* () {
    const request = yield* requestOf(providerConfig("openai-compatible"), environment({}));
    expect(String.startsWith("https://gateway.test/v1/")(request.url)).toBe(true);
    expect(Headers.has(request.headers, "authorization")).toBe(false);
  }),
);

const ModelNames = Schema.Struct({
  model: Schema.optionalKey(Schema.Literals(["big-model", "other-model"])),
  small: Schema.optionalKey(Schema.Literals(["small-model", "tiny-model"])),
});

it.prop(
  "planner.small serves index and the two splits when it is set, and planner.model serves every call otherwise",
  [PlannerCall, ModelNames],
  ([call, planner]) => {
    const config = Schema.decodeSync(CairnConfig)({ planner });
    const isSmall = Array.contains(["index", "splitSection", "splitTask"], call);
    const expected = isSmall
      ? Option.orElse(Option.fromUndefinedOr(planner.small), () =>
          Option.fromUndefinedOr(planner.model),
        )
      : Option.fromUndefinedOr(planner.model);
    expect(modelNameFor(config, call)).toEqual(expected);
  },
);

it.effect.prop(
  "the api layer sends the small model for index and the model for spec",
  [PlannerCall],
  ([call]) =>
    Effect.gen(function* () {
      const config = configOf({ model: "big-model", small: "small-model" });
      yield* LanguageModel.generateText({ prompt: "x" }).pipe(
        Effect.provide(
          languageModelFor(config, call).pipe(
            Layer.provide(withKey),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      const request = yield* sent;
      expect(request.model).toBe(
        Array.contains(["index", "splitSection", "splitTask"], call) ? "small-model" : "big-model",
      );
    }).pipe(Effect.provide(wire(replies))),
);

it.effect("a config that picks api with no model fails the layer instead of calling a model", () =>
  Effect.gen(function* () {
    // The config schema refuses this, so build the value the way a caller bypassing it would.
    const config = Struct.evolve(apiConfig, { planner: Struct.omit(["model"]) });
    const failure = yield* Effect.flip(
      Layer.build(languageModel(config).pipe(Layer.provide(withKey))).pipe(Effect.scoped),
    ).pipe(Effect.flatMap(only(Schema.is(ModelUnavailable))));
    expect(failure.message).toContain("planner.model");
  }).pipe(Effect.provide(Layer.mergeAll(wire(replies), NodeServices.layer))),
);

/** The prompt files, filled from fixed values that hold no placeholder of their own. */
const rendered = Effect.gen(function* () {
  const prompts = yield* loadPrompts(defaultConfig.judge.models);
  return {
    retry: yield* prompts.retry("the first prompt", "the decode error"),
    spec: yield* prompts.spec("the prd"),
    tasks: yield* prompts.tasks("the prd", "the spec", [], []),
  };
}).pipe(Effect.provide(NodeServices.layer));

it.effect("every placeholder of every prompt file is filled", () =>
  Effect.gen(function* () {
    const prompts = yield* rendered;
    Array.forEach(Record.values(prompts), (prompt) => {
      expect(prompt).not.toMatch(/\{\{[^{}]*\}\}/u);
    });
  }),
);

it.effect(
  "the tasks prompt holds the PRD, the spec, the model table and every reasoning level",
  () =>
    Effect.gen(function* () {
      const { tasks } = yield* rendered;
      expect(tasks).toContain("the prd");
      expect(tasks).toContain("the spec");
      Array.forEach(Record.toEntries(defaultConfig.judge.models), ([name, use]) => {
        expect(tasks).toContain(name);
        expect(tasks).toContain(use);
      });
      Array.forEach(["low", "medium", "high", "xhigh", "max"], (level) => {
        expect(tasks).toContain(`\`${level}\``);
      });
    }),
);

it.effect("the tasks prompt shows the model table of the config it was made for", () =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeEffect(CairnConfig)({
      judge: { models: { tiny: "Changes that need no thought" } },
    });
    const prompts = yield* loadPrompts(config.judge.models);
    const prompt = yield* prompts.tasks("prd", "spec", [], []);
    expect(prompt).toContain("tiny");
    expect(prompt).toContain("Changes that need no thought");
    expect(prompt).not.toContain("haiku");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("the spec prompt says when to draw a Mermaid diagram and when not to", () =>
  Effect.gen(function* () {
    const { spec: prompt } = yield* rendered;
    expect(prompt).toContain("mermaid");
    expect(prompt).toContain("a machine's states and events");
    expect(prompt).toContain("messages between two processes");
    expect(prompt).toContain("passes through three or more steps");
    expect(prompt).toContain("Do not draw one for anything a list already says");
  }),
);

it.effect("the retry prompt holds the first prompt and the decode error", () =>
  Effect.gen(function* () {
    const { retry } = yield* rendered;
    expect(retry).toContain("the first prompt");
    expect(retry).toContain("the decode error");
  }),
);

it.effect.prop(
  "a value goes into a prompt as it is, even one that looks like a placeholder or a replacement",
  [Schema.String, Schema.String],
  ([prd, specText]) =>
    Effect.gen(function* () {
      const prompts = yield* loadPrompts(defaultConfig.judge.models);
      const prompt = yield* prompts.tasks(prd, specText, [], []);
      expect(prompt).toContain(prd);
      expect(prompt).toContain(specText);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.prop(
  "a placeholder is filled wherever it appears, and only with its own value",
  [Schema.String, Schema.String],
  ([one, two]) =>
    Effect.gen(function* () {
      const filled = yield* fillPrompt("t", "{{a}}-{{b}}-{{a}}", { a: one, b: two });
      expect(filled).toBe(`${one}-${two}-${one}`);
    }),
);

const failureOf = (template: string, values: Record<string, string>) =>
  Effect.flip(fillPrompt("t", template, values));

it.effect("a placeholder with no value is a PromptError that names it", () =>
  Effect.gen(function* () {
    const failure = yield* failureOf("{{a}} and {{unknown}}", { a: "x" });
    expect(Schema.is(PromptError)(failure)).toBe(true);
    expect(failure.reason).toContain("unknown");
    expect(failure.message).toContain("unknown");
  }),
);

it.effect("a value with no placeholder is a PromptError that names it", () =>
  Effect.gen(function* () {
    const failure = yield* failureOf("{{a}}", { a: "x", extra: "y" });
    expect(failure.reason).toContain("extra");
  }),
);

it.effect("a placeholder spelled with spaces is not silently kept", () =>
  Effect.gen(function* () {
    const failure = yield* failureOf("{{ a }}", { a: "x" });
    expect(Schema.is(PromptError)(failure)).toBe(true);
  }),
);

it.effect("a prompt file that cannot be read fails the layer with a PromptError", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(loadPrompts(defaultConfig.judge.models));
    expect(Schema.is(PromptError)(failure)).toBe(true);
    expect(failure.message).toContain("no such file");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        FileSystem.layerNoop({
          readFileString: () =>
            Effect.fail(
              systemError({
                _tag: "NotFound",
                description: "no such file",
                method: "readFileString",
                module: "FileSystem",
              }),
            ),
        }),
      ),
    ),
  ),
);
