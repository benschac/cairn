import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "CairnSite",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // The viewer is a client-only Vite app: a deep link falls back to index.html and boots it.
    const demo = yield* Cloudflare.Website.Vite("Demo", {
      rootDir: "../viewer",
      domain: { name: "prdtrace.com", redirects: ["www.prdtrace.com"] },
      assets: { notFoundHandling: "single-page-application" },
    });
    // The gateway the planner's API calls go through, for logs and spend (see spec.models).
    // Cloudflare requires authentication on a new gateway, so callers send its token.
    const gateway = yield* Cloudflare.AI.Gateway("Planner", {
      authentication: true,
      collectLogs: true,
    });
    return { url: demo.url, gatewayId: gateway.gatewayId, accountId: gateway.accountId };
  }),
);
