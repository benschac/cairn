import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

import { sharedTest } from "../../vitest.shared.ts";

export default defineConfig(({ mode }) => {
  // The same variable and default as the presence server in packages/cli/src/serve.ts.
  const port = loadEnv(mode, import.meta.dirname, "CAIRN_")["CAIRN_PRESENCE_PORT"] ?? "4310";
  const proxy = {
    "/api": { target: `http://localhost:${port}` },
    "/presence": { target: `ws://localhost:${port}`, ws: true },
  };
  return {
    // NOTE: `src/effect-ui/bridge.ts` imports Foldkit's html module by its path, to reach the
    // render frame (`__setRuntime`), and the views import it as `foldkit/html`. Pre-bundled,
    // `foldkit/html` would be a second copy under `.vite/deps` with a frame of its own, and a
    // bridged view would throw that it was built outside a render. Served from `node_modules`,
    // both specifiers reach one module. The exclusion goes with Foldkit.
    optimizeDeps: { exclude: ["foldkit", "@foldkit/ui"] },
    preview: { proxy },
    server: {
      allowedHosts: [".trycloudflare.com"],
      proxy,
    },
    test: sharedTest,
  };
});
