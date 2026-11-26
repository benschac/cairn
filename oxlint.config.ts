import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { defineConfig } from "oxlint";

const fromCore = createRequire(new URL("packages/core/package.json", import.meta.url));
const fromRoot = createRequire(import.meta.url);
// The Foldkit rules (foldkit/*) at the severities, and with the overrides, of the plugin's preset.
const foldkit = fromRoot("@foldkit/oxlint-plugin/recommended.json");

// Ports inside, adapters outside: core and contract take plain values and do no IO
// (spec.package-layout). A job that needs disk, git, a socket or a model is a Context.Service
// declared here and implemented in packages/cli, which supplies it as a Layer. The rat-stack
// page behind the rule: .agent_sources/ratstack/docs.txt, /lore/hexagonal-architecture.
const PORT =
  "Fix: declare a Context.Service for the job in core and implement it in packages/cli, which provides the Layer.";
// Node's IO modules; child_process is added unless a file is allowed it.
const NODE_IO =
  "cluster|dgram|dns|fs|http|http2|https|net|os|process|readline|sqlite|tls|worker_threads";
const insideImports = ({ contract = false, childProcess = false } = {}) => ({
  paths: [
    {
      name: "effect",
      importNames: ["FileSystem", "Stdio", "Terminal"],
      message: `FileSystem, Stdio and Terminal are IO; core and contract take plain values. ${PORT}`,
    },
  ],
  patterns: [
    {
      regex: `^(node:)?(${childProcess ? "" : "child_process|"}${NODE_IO})(/|$)`,
      message: `Node IO in core or contract, which take plain values. ${PORT}`,
    },
    {
      regex: "^@effect/(platform|sql|ai)-",
      message: `A provider package is an adapter, so it lives in packages/cli. ${PORT}`,
    },
    {
      regex:
        "^effect/(FileSystem|Stdio|Terminal|cli|cluster|http|http-api|net|persistence|process|rpc|socket|sql|workers|workflow)(/|$)",
      message: `An Effect transport or IO module is an adapter, so it lives in packages/cli. ${PORT}`,
    },
    {
      regex: "^(@cairn/(cli|viewer|site)|(\\.\\./)+(packages/)?(cli|apps)/)",
      message:
        "core and contract sit below the CLI and the apps. Fix: move the shared piece down into core or contract.",
    },
    ...(contract
      ? [
          {
            regex: "^(@cairn/core|(\\.\\./)+(packages/)?core/)",
            message:
              "contract sits below core. Fix: move the schema into packages/contract and import it from core.",
          },
        ]
      : []),
  ],
});

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
  overrides: [
    ...foldkit.overrides,
    {
      files: ["packages/core/src/**"],
      rules: { "no-restricted-imports": ["error", insideImports()] },
    },
    {
      files: ["packages/contract/src/**"],
      rules: { "no-restricted-imports": ["error", insideImports({ contract: true })] },
    },
    // The plain JS entry for orchestrators finds .cairn with one git call (spec.contract).
    {
      files: ["packages/contract/src/js.ts"],
      rules: {
        "no-restricted-imports": ["error", insideImports({ contract: true, childProcess: true })],
      },
    },
  ],
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
