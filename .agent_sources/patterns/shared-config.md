# Shared configuration: the environment as a service

Credit: Harry Solovay, "Advanced Effect Design Patterns", Effect Miami 3, chapter IX
"Shared configuration", from [29:41](https://youtu.be/_tSGby_q890?t=1781). The PRD credits it in
`prd.implementation-in-effect`.

> Make the environment a service, built from a shared base that each package extends.

Each package gets one typed, redacted, validated object. The shared fields are defined once, and
the code that deploys a service reads the same definition the service runs with.

## The pattern

1. A shared base reads what every entrypoint needs with `Config.all`. A value that has a format is
   read through a schema with `Config.schema`; a secret is `Config.Redacted`; a value derived from
   another one is `Config.map` over it, not a second variable.

   ```ts
   export const SharedEnv = Effect.gen(function* () {
     const STAGE = Config.schema(Stage, "STAGE");
     return yield* Config.all({
       STAGE,
       OTEL_EXPORTER_OTLP_ENDPOINT: Config.String("OTEL_EXPORTER_OTLP_ENDPOINT"),
       OTEL_EXPORTER_OTLP_HEADERS: Config.Redacted("OTEL_EXPORTER_OTLP_HEADERS"),
       OTEL_METRICS_EXPORTER: STAGE.pipe(Config.map((v) => (v.startsWith("dev_") ? "none" : "otlp"))),
     });
   });
   ```

2. Each package extends it in a `Context.Service` whose `make` reads only that package's own
   variables and merges the base in.

   ```ts
   export class ServiceAEnv extends Context.Service<ServiceAEnv>()("service-a/Env", {
     make: Effect.gen(function* () {
       const shared = yield* SharedEnv;
       return yield* Config.all({
         STRIPE_API_KEY: Config.Redacted("STRIPE_API_KEY"),
       }).pipe(Effect.map(Struct.assign(shared)));
     }),
   }) {}
   ```

   `Struct.assign(that)(self)` lets `that` win a shared key, so here the base wins over a package
   field of the same name. Do not give a package field a base field's name.

3. Deploy and runtime agree. The Worker's init runs `make` and provides the result as a layer:

   ```ts
   const layerEnv = yield* ServiceAEnv.make.pipe(Effect.map(Layer.succeed(ServiceAEnv)));
   return { fetch: app.pipe(Effect.provide(layerEnv)) };
   ```

   At deploy, Alchemy runs that init and binds every `Config` it reads onto the Worker as a secret.
   At runtime the same reads resolve from the Worker's environment. A variable the service needs
   and the deploy lacks fails the deploy, not the first request.

4. Secrets reach CI from one local run. An Alchemy stack run once from a laptop reads the local
   `.env`, and each `Config.Redacted` becomes a GitHub repository secret:

   ```ts
   export default Alchemy.Stack(
     "ci-secrets",
     { state: Cloudflare.state(), providers: GitHub.providers() },
     GitHub.Secrets({
       owner, repository,
       secrets: { CLOUDFLARE_API_TOKEN: Config.Redacted("CLOUDFLARE_API_TOKEN") },
     }),
   );
   ```

   The workflow passes them to `alchemy deploy` as env. The chain is
   `.env -> GitHub secret -> workflow env -> Worker secret -> yield* ServiceAEnv`, and it is the same
   `Config.Redacted("NAME")` at every step. Alchemy's own repository does this in
   `.agent_sources/github.com/alchemy-run/alchemy/stacks/src/github.ts`.

## In Cairn

Read the installed declarations before you write it: `Config.all`, `Config.schema`,
`Config.Redacted` and `Config.map` in `node_modules/effect/dist/Config.d.ts`, `Struct.assign` in
`Struct.d.ts`, and the `make` option of `Context.Service` in `Context.d.ts`. Look them up in
`core-index.md`.

- A test provides the env service with `Layer.succeed`, or builds it from
  `ConfigProvider.fromEnvRecord`; it never reads the process environment.
- The CLI reads a model key only when the layer that needs it is built (`spec.models`): a command
  that never calls a model never asks for its key. So the CLI's base holds what every command
  reads, and each command's env extends it with its own keys. Do not read every key up front.
- Every `Config.Redacted` value the CLI reads goes to the `Redactor`'s secret set
  (`spec.models`). One env service per command is the one place to collect them.
- A browser bundle has no environment. The viewer picks its source at build time
  (`__CAIRN_SOURCE__`), so this pattern does not apply there.

## Where it applies

Code today:

| Where | What it reads now | With the pattern |
| --- | --- | --- |
| `packages/cli/src/serve.ts` | `CAIRN_PRESENCE_PORT` as a module-level `Config.Port` | A field of the CLI's base env, with its default |
| `packages/cli/src/models.ts` | The planner key (`planner.keyEnv` or the provider's own), `planner.gatewayTokenEnv`, `TYPESAFE_API_KEY` and `judge.gatewayTokenEnv`, each read where its layer is built, in `requiredKey`, `optionalKey`, `withGatewayToken`, `judgingAvailable` and `typeSafeClient` | A planner env and a judge env, each a function of `CairnConfig` (the variable names come from config) that extends the base; the `ModelKeyError` messages stay with them |
| `packages/cli/src/environment.ts` | The `.env` fallback `ConfigProvider` | Unchanged: it is where the env services resolve from |
| `packages/cli/test/*.test.ts` (about a dozen files) | `ConfigProvider.layer(ConfigProvider.fromEnvRecord(...))` to blank or fake the environment | `Layer.succeed` of the env service in tests that are not about reading it |
| `apps/site/alchemy.run.ts` | Nothing yet. It creates the `Planner` AI Gateway and returns its `gatewayId` and `accountId` | The deploy and the CLI share the gateway's env definition instead of a person copying IDs into `.cairn/config.json` |
| `.github/workflows/ci.yml` (`deploy`) | `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, set in GitHub by hand | A bootstrap stack with `GitHub.Secrets` writes them from the owner's `.env`. AGENTS.md says the owner manages these secrets, so ask the owner first |

Planned in the PRD and spec:

| Where | Variables | Spec |
| --- | --- | --- |
| `apps/hosted/src/config.ts` | `CAIRN_DOMAIN`, `CAIRN_STAGE`, `CAIRN_AUTH`, `CAIRN_BILLING`, `CAIRN_SOCIAL_IMAGE`, `CAIRN_SUPPORT`, `OPERATOR_TOKEN`. This is the slide's shared base almost exactly: `CAIRN_STAGE` is `STAGE`, and `CAIRN_AUTH` and `CAIRN_BILLING` decide which secrets the rest must read | `spec.hosted-launch.self-hosting` |
| The hosted Worker's sign-in | GitHub and Google OAuth client IDs and secrets, Better Auth's own secret; read only for the providers `CAIRN_AUTH` names | `spec.hosted-launch.worker-and-storage`, `prd.v2-multiplayer-on-cloudflare.accounts` ("The OAuth client secrets are Alchemy config bindings") |
| The GitHub App | App ID and private key | `prd.v2-multiplayer-on-cloudflare.permissions` ("Alchemy config bindings, like the OAuth client secrets") |
| Billing | Stripe keys, read only when `CAIRN_BILLING` is `managed` | `spec.hosted-launch.billing` |
| `apps/hosted/alchemy.run.ts` | Binds all of the above as Worker secrets by running the Worker's init: "`alchemy deploy` brings up a working room from an empty Cloudflare account, given the GitHub and Google OAuth client credentials" | `prd.v2-multiplayer-on-cloudflare.architecture`, `prd.v2-multiplayer-on-cloudflare.multiplayer-acceptance-criteria` |
| `.github/workflows/restore-drill.yml` | Deploys throwaway stages, so it needs the deploy secrets in CI | `spec.hosted-launch.self-hosting` |
| `cairn connect` | `CAIRN_AGENT_TOKEN` in place of the stored agent | `spec.hosted-launch.cairn-connect` |
| `cairn admin backup`, `cairn admin restore` | `CAIRN_OPERATOR_TOKEN` | `spec.hosted-launch.self-hosting` |
| `cairn doctor` | Checks for "the API key the provider needs". Running the planner env's `make` means doctor and `cairn plan` cannot disagree about what is required | `prd.cli.doctor` |
| Session redaction | "strip values matching env var names from `.env*`": the env services list every secret Cairn reads | `prd.redaction`, `spec.models` |
| Cloudflare AI Gateway | `gateway.tokenEnv`, the account and gateway IDs | `spec.judging.cloudflare-ai-gateway` (`prd.judging-the-plan.gateway`) |
