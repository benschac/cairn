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
    const demo = yield* Cloudflare.Website.Foldkit("Demo", {
      rootDir: "../viewer",
    });
    return { url: demo.url };
  }),
);
