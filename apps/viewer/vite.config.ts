import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

const presence = {
  "/presence": { target: "ws://localhost:4310", ws: true },
};

export default defineConfig({
  plugins: [foldkit()],
  preview: { proxy: presence },
  server: {
    allowedHosts: [".trycloudflare.com"],
    proxy: presence,
  },
});
