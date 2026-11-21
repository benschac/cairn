import { createRequire } from "node:module";

import { defineConfig } from "oxlint";

const fromCore = createRequire(new URL("packages/core/package.json", import.meta.url));

export default defineConfig({
  categories: {
    correctness: "error",
    perf: "error",
    suspicious: "error",
  },
  ignorePatterns: ["**/dist/**", "**/node_modules/**", ".claude/**"],
  jsPlugins: [fromCore.resolve("@xstate/effect/oxlint")],
  options: {
    typeAware: true,
  },
  plugins: ["typescript", "unicorn", "oxc", "import", "promise", "vitest"],
  rules: {
    "typescript/no-explicit-any": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-non-null-assertion": "error",
    "vitest/no-standalone-expect": "off",
    "xstate-effect/no-inline-effect": "error",
  },
});
