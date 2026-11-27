import { D1Client } from "@effect/sql-d1";
import { Context, Layer } from "effect";

import type { WorkerEnv } from "../alchemy.run.ts";

declare global {
  namespace Cloudflare {
    /** The `env` that `cloudflare:workers` exports is the one `alchemy.run.ts` binds. */
    interface Env extends WorkerEnv {}
  }
}

/** The Worker's bindings, as `alchemy.run.ts` declares them. */
export class HostedEnv extends Context.Service<HostedEnv, WorkerEnv>()("@cairn/hosted/HostedEnv") {
  /** The bindings, and D1 as the `SqlClient`. Built once per isolate, from the bindings alone. */
  static readonly layer = (env: WorkerEnv) =>
    Layer.merge(Layer.succeed(HostedEnv, env), D1Client.layer({ db: env.DB }));
}
