import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

// Every deploy applies the migrations it has not applied yet, in the order of their numeric prefix.
export const Database = Cloudflare.D1.Database("Database", { migrations: "./src/d1/migrations" });

// Revision bodies over 512 KiB, reached only through a document's room (see spec.hosted-launch.room).
export const Blobs = Cloudflare.R2.Bucket("Blobs");

// Sign-in links and invitations. The sender's address is set by the deployment's domain.
export const Mail = Cloudflare.Email.SendEmail("Mail");

/** One Worker for every workspace. `src/worker.ts` exports its `fetch` and `scheduled` handlers. */
export const Hosted = Cloudflare.Worker("Hosted", {
  main: "./src/worker.ts",
  compatibility: { flags: ["nodejs_compat"], date: "2026-11-20" },
  // Retries the room calls of a revocation that failed (see spec.hosted-launch.room).
  crons: ["* * * * *"],
  env: { DB: Database, BLOBS: Blobs, MAIL: Mail },
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
