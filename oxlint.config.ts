import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { defineConfig } from "oxlint";

const fromCore = createRequire(new URL("packages/core/package.json", import.meta.url));
const fromRoot = createRequire(import.meta.url);
// The Foldkit rules (foldkit/*) at the severities, and with the overrides, of the plugin's preset.
const foldkit = fromRoot("@foldkit/oxlint-plugin/recommended.json");

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
    fileURLToPath(import.meta.resolve("@foldkit/oxlint-plugin")),
  ],
  options: {
    typeAware: true,
  },
  overrides: foldkit.overrides,
  plugins: ["typescript", "unicorn", "oxc", "import", "promise", "vitest"],
  rules: {
    ...foldkit.rules,
    "core/no-array-spread": "error",
    "core/no-length-check": "error",
    "core/no-native-collection": "error",
    "core/no-native-loop": "error",
    "core/no-native-sort": "error",
    "core/no-set-dedupe": "error",
    "core/no-switch": "error",
    "core/no-typeof-check": "error",
    "core/no-yield-in-loop": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-non-null-assertion": "error",
    "vitest/no-standalone-expect": "off",
    "xstate-effect/no-inline-effect": "error",
  },
});
