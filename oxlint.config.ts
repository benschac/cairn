import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { defineConfig } from "oxlint";

const fromCore = createRequire(new URL("packages/core/package.json", import.meta.url));

export default defineConfig({
  categories: {
    correctness: "error",
    perf: "error",
    suspicious: "error",
  },
  ignorePatterns: ["**/dist/**", "**/node_modules/**", ".claude/**", ".agent_sources/**"],
  // lint/effect-core-plugin.mjs: the Effect core module rules (core/*), see AGENTS.md.
  jsPlugins: [
    fromCore.resolve("@xstate/effect/oxlint"),
    fileURLToPath(new URL("lint/effect-core-plugin.mjs", import.meta.url)),
  ],
  options: {
    typeAware: true,
  },
  plugins: ["typescript", "unicorn", "oxc", "import", "promise", "vitest"],
  rules: {
    "core/no-native-sort": "error",
    "core/no-set-dedupe": "error",
    "core/no-yield-in-loop": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-non-null-assertion": "error",
    "vitest/no-standalone-expect": "off",
    "xstate-effect/no-inline-effect": "error",
  },
});
