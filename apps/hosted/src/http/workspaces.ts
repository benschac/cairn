import { CurrentUser, HostedApi } from "@cairn/contract/hosted";
import { D1Client } from "@effect/sql-d1";
import { Context, Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { AccountSettings, createWorkspace } from "../auth.ts";

/** `POST /api/workspaces`: a team workspace named `name`, with the caller as its owner, on the free plan. */
export const WorkspacesLive = HttpApiBuilder.group(HostedApi, "workspaces", (handlers) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<D1Client.D1Client | AccountSettings>();
    // The services the handler uses, without the scope this layer is built in.
    const services = Context.pick(D1Client.D1Client, AccountSettings)(context);
    return handlers.handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        return yield* createWorkspace({ owner: user.id, kind: "team", name: payload.name });
      }).pipe(Effect.provideContext(services), Effect.orDie),
    );
  }),
);
