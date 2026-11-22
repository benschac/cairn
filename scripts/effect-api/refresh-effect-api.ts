// Index the public modules of the installed Effect packages.
// Each package ships its declarations with JSDoc, its source and its agent
// guides at the installed version, so this writes one module index and copies
// nothing. It reads only local files.
//
//   node scripts/effect-api/refresh-effect-api.ts          write .agent_sources/effect/index.md
//   node scripts/effect-api/refresh-effect-api.ts --check  fail when that file does not match the installed packages

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Array,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Order,
  Path,
  pipe,
  Record,
  Result,
  Runtime,
  Schema,
} from "effect";
import { Command, Flag } from "effect/cli";

const INDEX = ".agent_sources/effect/index.md";
const REFRESH = "node scripts/effect-api/refresh-effect-api.ts";

// The program returns what it did for the command to log. Each failure logs its own message once (see the command below), so the runtime is told not to print it again.
class IndexFailed extends Schema.TaggedError<IndexFailed>()("IndexFailed", {
  reason: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return this.reason;
  }
}

const Manifest = Schema.Struct({
  version: Schema.optionalKey(Schema.String),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

const fail = (reason: string) => Effect.fail(new IndexFailed({ reason }));

const unquote = (text: string) => text.trim().replace(/^(["'])(.*)\1$/, "$2");

// The indented lines of one top-level block of pnpm-workspace.yaml, trimmed. The file is flat enough not to need a YAML parser.
const yamlBlock = (text: string, key: string) =>
  pipe(
    text.split("\n"),
    Array.dropWhile((line) => line !== `${key}:`),
    Array.drop(1),
    Array.takeWhile((line) => /^\s+\S/.test(line)),
    Array.map((line) => line.trim()),
  );

// The first sentence of a file's leading JSDoc block, or "" when it has none. Reference directives may precede the block.
const summaryOf = (text: string) => {
  const head = text.replace(/^(?:[ \t]*(?:\/\/\/[^\n]*)?\n)*/, "");
  if (!head.startsWith("/**")) return "";
  const paragraph: string[] = [];
  for (const raw of head.slice(3, head.indexOf("*/")).split("\n")) {
    const line = raw.replace(/^\s*\*?\s?/, "").trim();
    if (line.startsWith("@") || (!line && paragraph.length)) break;
    if (line) paragraph.push(line);
  }
  const prose = paragraph.join(" ");
  const sentence = /^.*?[.!?](?=\s|$)/.exec(prose)?.[0] ?? prose;
  return sentence.replaceAll("|", "\\|");
};

const exported =
  /^export (?:declare )?(?:abstract )?(?:const|function|type|interface|class|namespace|enum) /;

const refresh = Effect.fn("refreshEffectApi")(function* ({ check }: { check: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const shown = (dir: string) => path.relative(repo, dir) || ".";
  const readManifest = (file: string) =>
    fs.readFileString(file).pipe(Effect.flatMap(decodeManifest));

  // The workspaces that can declare an Effect dependency: the root and each folder a workspace glob names.
  const workspaceYaml = yield* fs.readFileString(path.join(repo, "pnpm-workspace.yaml"));
  const globs = Array.map(yamlBlock(workspaceYaml, "packages"), (item) => unquote(item.slice(1)));
  const catalog = Record.fromEntries(
    Array.filterMap(yamlBlock(workspaceYaml, "catalog"), (entry) => {
      const colon = entry.search(/:\s/);
      return colon === -1
        ? Result.failVoid
        : Result.succeed([
            unquote(entry.slice(0, colon)),
            unquote(entry.slice(colon + 1)),
          ] as const);
    }),
  );
  const nested = yield* Effect.forEach(
    globs,
    Effect.fnUntraced(function* (glob) {
      if (!glob.endsWith("/*")) return yield* fail(`Unsupported workspace pattern "${glob}"`);
      const parent = path.join(repo, glob.slice(0, -2));
      const names = yield* fs.readDirectory(parent);
      return yield* Effect.filter(
        Array.map(Array.sort(names, Order.String), (name) => path.join(parent, name)),
        (dir) => fs.exists(path.join(dir, "package.json")),
      );
    }),
  );
  const workspaces = [repo, ...Array.flatten(nested)];

  // The folders a workspace searches for a package: its own node_modules, then each parent's up to the root.
  const searchPath = (dir: string): string[] =>
    dir === repo || !dir.startsWith(repo) ? [repo] : [dir, ...searchPath(path.dirname(dir))];

  // Every Effect package a workspace depends on, with the copy it resolves.
  const declared = yield* Effect.forEach(
    workspaces,
    Effect.fnUntraced(function* (dir) {
      const manifest = yield* readManifest(path.join(dir, "package.json"));
      const effectDeps = Array.filter(
        Record.toEntries({ ...manifest.dependencies, ...manifest.devDependencies }),
        ([name]) => name === "effect" || name.startsWith("@effect/"),
      );
      return yield* Effect.forEach(
        effectDeps,
        Effect.fnUntraced(function* ([name, spec]) {
          const pin = spec === "catalog:" ? catalog[name] : spec;
          if (pin === undefined) {
            return yield* fail(
              `${shown(dir)} pins ${name} to the catalog, which has no entry for it`,
            );
          }
          const found = yield* Effect.findFirst(
            Array.map(searchPath(dir), (parent) => path.join(parent, "node_modules", name)),
            (candidate) => fs.exists(path.join(candidate, "package.json")),
          );
          if (Option.isNone(found)) {
            return yield* fail(`${name} is not installed for ${shown(dir)}; run pnpm install`);
          }
          const installed = yield* readManifest(path.join(found.value, "package.json"));
          const version = installed.version ?? "";
          if (version !== pin) {
            return yield* fail(
              `${shown(dir)} pins ${name}@${pin} but ${version} is installed; run pnpm install`,
            );
          }
          // pnpm links each workspace's copy into the store, so two links name one copy when their real paths agree.
          const real = yield* fs.realPath(found.value);
          return { name, version, dir: found.value, real };
        }),
      );
    }),
  );
  const byName = Array.groupBy(Array.flatten(declared), (pkg) => pkg.name);
  const packages = yield* Effect.forEach(Record.toEntries(byName), ([name, copies]) => {
    const [first] = copies;
    const other = Array.findFirst(copies, (copy) => copy.real !== first.real);
    return Option.isSome(other)
      ? fail(`${name} resolves to two copies: ${shown(first.real)} and ${shown(other.value.real)}`)
      : Effect.succeed(first);
  });
  // The core package leads; the scoped packages follow by name.
  const ordered = Array.sortBy(
    Order.mapInput(Order.Boolean, (pkg: (typeof packages)[number]) => pkg.name !== "effect"),
    Order.mapInput(Order.String, (pkg: (typeof packages)[number]) => pkg.name),
  )(packages);

  const indexed = yield* Effect.forEach(
    ordered,
    Effect.fnUntraced(function* (pkg) {
      const dist = path.join(pkg.dir, "dist");
      // Public declaration files under dist: every module the package's "./*" export exposes.
      const listing = (yield* fs.exists(dist))
        ? yield* fs.readDirectory(dist, { recursive: true })
        : [];
      const modules = Array.sort(
        Array.filterMap(listing, (file) =>
          file.endsWith(".d.ts") &&
          path.basename(file) !== "index.d.ts" &&
          !file.split(path.sep).includes("internal")
            ? Result.succeed(file.slice(0, -".d.ts".length))
            : Result.failVoid,
        ),
        Order.String,
      );
      const rows = yield* Effect.forEach(
        modules,
        Effect.fnUntraced(function* (module) {
          const declarations = yield* fs.readFileString(path.join(dist, `${module}.d.ts`));
          const lines = declarations.split("\n");
          const count = Array.filter(lines, (line) => exported.test(line)).length;
          // The compiler drops a module's leading JSDoc when imports follow it, so read the shipped source first.
          const source = path.join(pkg.dir, "src", `${module}.ts`);
          const sourceText = (yield* fs.exists(source)) ? yield* fs.readFileString(source) : "";
          const sourceSummary = summaryOf(sourceText);
          // A module that only forwards another one has no declarations of its own; name where they live.
          const forwarded = Array.map(
            [...declarations.matchAll(/^export \* from "([^"]+)"/gm)],
            (match) => `\`${match[1]}\``,
          );
          const summary =
            sourceSummary ||
            summaryOf(declarations) ||
            (forwarded.length ? `Re-exports ${forwarded.join(", ")}.` : "");
          return {
            count,
            row: `| ${pkg.name}/${module} | ${count} | ${lines.length} | ${summary} |`,
          };
        }),
      );
      const location = shown(pkg.dir);
      const guides = yield* Effect.filter(["AGENTS.md", "ai-docs", "README.md"], (guide) =>
        fs.exists(path.join(pkg.dir, guide)),
      );
      const exports = Array.reduce(rows, 0, (sum, { count }) => sum + count);
      return {
        rows,
        total: `| ${pkg.name} | ${pkg.version} | ${rows.length} | ${exports} | \`${location}/dist\` |`,
        section: [
          `## ${pkg.name}@${pkg.version}`,
          "",
          `Declarations: \`${location}/dist/<module>.d.ts\`. Guides: ${Array.map(guides, (guide) => `\`${location}/${guide}\``).join(", ")}.`,
          "",
          "| Module | Exports | Lines | Summary |",
          "| --- | ---: | ---: | --- |",
          ...Array.map(rows, ({ row }) => row),
          "",
        ],
      };
    }),
  );
  const withModules = Array.filter(indexed, ({ rows }) => rows.length > 0);
  if (!withModules.length) return yield* fail("No installed Effect package has declaration files");

  const index = [
    "# Effect API index",
    "",
    `Generated by \`scripts/effect-api/refresh-effect-api.ts\` from the installed packages. Do not edit it; \`pnpm check:effect-api\` fails when it is stale.`,
    "",
    "Each row is one public module, named by its import path. Drop the package name to get its file under the package's declarations folder, then list its exports:",
    "",
    "```sh",
    "rg -n '^export ' node_modules/effect/dist/Logger.d.ts",
    "```",
    "",
    "Read [the source guide](../README.md) before applying examples.",
    "",
    "| Package | Version | Modules | Exports | Declarations |",
    "| --- | --- | ---: | ---: | --- |",
    ...Array.map(withModules, ({ total }) => total),
    "",
    ...Array.flatMap(withModules, ({ section }) => section),
  ].join("\n");

  const target = path.join(repo, INDEX);
  if (check) {
    const current = (yield* fs.exists(target)) ? yield* fs.readFileString(target) : "";
    if (current !== index) {
      return yield* fail(`${INDEX} does not match the installed Effect packages; run ${REFRESH}`);
    }
    return `${INDEX} matches the installed Effect packages`;
  }
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, index);
  return `Indexed ${withModules.length} Effect packages in ${INDEX}`;
});

const command = Command.make(
  "refresh-effect-api",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(`Fail when ${INDEX} does not match the installed packages`),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    refresh(input).pipe(
      Effect.flatMap(Effect.logInfo),
      Effect.tapErrorTag("IndexFailed", (error) => Effect.logError(error.message)),
    ),
).pipe(Command.withDescription("Index the public modules of the installed Effect packages"));

// Logs go to stderr.
const logger = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(logger, NodeServices.layer)),
  NodeRuntime.runMain,
);
