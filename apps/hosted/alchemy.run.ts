import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

// Every deploy applies the migrations it has not applied yet, in the order of their numeric prefix.
export const Database = Cloudflare.D1.Database("Database", { migrations: "./src/d1/migrations" });

// Revision bodies over 512 KiB, reached only through a document's room (see spec.hosted-launch.room).
export const Blobs = Cloudflare.R2.Bucket("Blobs");

// Sign-in links and invitations. The sender's address is set by the deployment's domain.
export const Mail = Cloudflare.Email.SendEmail("Mail");

/** A secret the deployment may leave unset: empty is unset, and a way in that needs it stays off. */
const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")));

/** One Worker for every workspace. `src/worker.ts` exports its `fetch` and `scheduled` handlers. */
export const Hosted = Cloudflare.Worker("Hosted", {
  main: "./src/worker.ts",
  compatibility: { flags: ["nodejs_compat"], date: "2026-11-20" },
  // Retries the room calls of a revocation that failed (see spec.hosted-launch.room).
  crons: ["* * * * *"],
  env: {
    DB: Database,
    BLOBS: Blobs,
    MAIL: Mail,
    // The site's domain: sign-in runs on it, and mail comes from a subdomain of it.
    CAIRN_DOMAIN: Config.String("CAIRN_DOMAIN"),
    // The ways in an operator turns on, a subset of `github,google,email`.
    CAIRN_AUTH: Config.String("CAIRN_AUTH").pipe(Config.withDefault("github,google,email")),
    // `managed` puts a new workspace on the free plan; `off` puts every workspace on `self-hosted`.
    CAIRN_BILLING: Config.String("CAIRN_BILLING").pipe(Config.withDefault("managed")),
    // Signs Better Auth's session cookies: made once, kept across deploys.
    AUTH_SECRET: Alchemy.makeRandom("AuthSecret"),
    GITHUB_CLIENT_ID: optionalSecret("GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: optionalSecret("GITHUB_CLIENT_SECRET"),
    GOOGLE_CLIENT_ID: optionalSecret("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: optionalSecret("GOOGLE_CLIENT_SECRET"),
  },
});

/** The bindings the Worker receives, derived from the declaration above so the two cannot drift. */
export type WorkerEnv = Cloudflare.InferEnv<typeof Hosted>;

export default Alchemy.Stack(
  "CairnHosted",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Hosted;
    return { url: worker.url };
  }),
);
