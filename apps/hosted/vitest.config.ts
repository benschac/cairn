import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { sharedTest } from "../../vitest.shared.ts";

// The tests run inside workerd, with local D1 and R2 bindings named as `alchemy.run.ts` names them.
// The D1 migrations are read here, in Node, and applied by the tests through `applyD1Migrations`.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-11-20",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["BLOBS"],
        bindings: { MIGRATIONS: await readD1Migrations("./src/d1/migrations") },
      },
    }),
  ],
  test: { testTimeout: sharedTest.testTimeout },
}));
