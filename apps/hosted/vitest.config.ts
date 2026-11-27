import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { sharedTest } from "../../vitest.shared.ts";

// The tests run inside workerd, with local D1 and R2 bindings and settings named as `alchemy.run.ts`
// names them.
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
        bindings: {
          MIGRATIONS: await readD1Migrations("./src/d1/migrations"),
          CAIRN_DOMAIN: "hosted.test",
          CAIRN_AUTH: "email",
          CAIRN_BILLING: "managed",
          AUTH_SECRET: "a-test-secret-that-signs-no-real-session",
          GITHUB_CLIENT_ID: "",
          GITHUB_CLIENT_SECRET: "",
          GOOGLE_CLIENT_ID: "",
          GOOGLE_CLIENT_SECRET: "",
        },
      },
    }),
  ],
  // Alchemy's bundler folds this flag for a deployed Worker, which drops its deploy-time code paths.
  define: { "globalThis.__ALCHEMY_RUNTIME__": "true" },
  test: { testTimeout: sharedTest.testTimeout },
}));
