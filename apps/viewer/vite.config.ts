import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // The same variable and default as the presence server in packages/cli/src/serve.ts.
  const port = loadEnv(mode, import.meta.dirname, "CAIRN_")["CAIRN_PRESENCE_PORT"] ?? "4310";
  const presence = {
    "/presence": { target: `ws://localhost:${port}`, ws: true },
  };
  return {
    plugins: [foldkit()],
    preview: { proxy: presence },
    server: {
      allowedHosts: [".trycloudflare.com"],
      proxy: presence,
    },
  };
});
