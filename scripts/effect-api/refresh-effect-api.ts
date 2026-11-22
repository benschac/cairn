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
  Number,
  Option,
  Order,
  Path,
  pipe,
  Predicate,
  Record,
  Result,
  Runtime,
  Schema,
  String,
} from "effect";
import { Command, Flag } from "effect/cli";
import { Yaml } from "effect/encoding";

import { escapeCell } from "../agent-sources/markdown.ts";

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

// A record field that may be absent, decoded as an empty record.
const Pins = Schema.Record(Schema.String, Schema.String).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed({})),
);
const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ dependencies: Pins, devDependencies: Pins })),
);
const decodeInstalled = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.Struct({
    packages: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    catalog: Pins,
  }),
);

const fail = (reason: string) => Effect.fail(new IndexFailed({ reason }));

// The first sentence of a file's leading JSDoc block, or "" when it has none. Reference directives may precede the block.
// The paragraph runs from the first non-empty line to the next blank line or tag.
const summaryOf = (text: string) => {
  const head = String.replace(/^(?:[ \t]*(?:\/\/\/[^\n]*)?\n)*/, "")(text);
  if (!String.startsWith("/**")(head)) return "";
  const end = pipe(
    head,
    String.indexOf("*/"),
    Option.getOrElse(() => -1),
  );
  const prose = pipe(
    String.slice(3, end)(head),
    String.split("\n"),
    Array.map((raw) => pipe(raw, String.replace(/^\s*\*?\s?/, ""), String.trim)),
    Array.dropWhile(String.isEmpty),
    Array.takeWhile((line) => String.isNonEmpty(line) && !String.startsWith("@")(line)),
    Array.join(" "),
  );
  return pipe(
    prose,
    String.match(/^.*?[.!?](?=\s|$)/),
    Option.map((match) => match[0]),
    Option.getOrElse(() => prose),
    escapeCell,
  );
};

const exported =
  /^export (?:declare )?(?:abstract )?(?:const|function|type|interface|class|namespace|enum) /;

const refresh = Effect.fn("refreshEffectApi")(function* ({ check }: { check: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const shown = (dir: string) => {
    const relative = path.relative(repo, dir);
    return String.isEmpty(relative) ? "." : relative;
  };

  // The workspaces that can declare an Effect dependency: the root and each folder a workspace glob names.
  const workspaceYaml = yield* fs.readFileString(path.join(repo, "pnpm-workspace.yaml"));
  const { packages: globs, catalog } = yield* Effect.try({
    try: () => Yaml.parse(workspaceYaml),
    catch: (cause) =>
      new IndexFailed({
        reason: `pnpm-workspace.yaml is not valid YAML: ${Predicate.isError(cause) ? cause.message : "unknown error"}`,
      }),
  }).pipe(Effect.flatMap(decodeWorkspace));
  const nested = yield* Effect.forEach(
    globs,
    Effect.fnUntraced(function* (glob) {
      if (!String.endsWith("/*")(glob))
        return yield* fail(`Unsupported workspace pattern "${glob}"`);
      const parent = path.join(repo, String.slice(0, -2)(glob));
      const names = yield* fs.readDirectory(parent);
      return yield* Effect.filter(
        Array.map(Array.sort(names, Order.String), (name) => path.join(parent, name)),
        (dir) => fs.exists(path.join(dir, "package.json")),
      );
    }),
  );
  const workspaces = Array.prepend(Array.flatten(nested), repo);

  // The folders a workspace searches for a package: its own node_modules, then each parent's up to the root.
  const searchPath = (dir: string): Array.NonEmptyArray<string> =>
    dir === repo || !String.startsWith(repo)(dir)
      ? [repo]
      : Array.prepend(searchPath(path.dirname(dir)), dir);

  // Every Effect package a workspace depends on, with the copy it resolves.
  const declared = yield* Effect.forEach(
    workspaces,
    Effect.fnUntraced(function* (dir) {
      const manifest = yield* fs
        .readFileString(path.join(dir, "package.json"))
        .pipe(Effect.flatMap(decodeManifest));
      const effectDeps = Array.filter(
        Record.toEntries(
          Record.union(manifest.dependencies, manifest.devDependencies, (_, dev) => dev),
        ),
        ([name]) => name === "effect" || String.startsWith("@effect/")(name),
      );
      return yield* Effect.forEach(
        effectDeps,
        Effect.fnUntraced(function* ([name, spec]) {
          const pin = yield* Effect.fromOption(
            spec === "catalog:" ? Record.get(catalog, name) : Option.some(spec),
            () =>
              new IndexFailed({
                reason: `${shown(dir)} pins ${name} to the catalog, which has no entry for it`,
              }),
          );
          const found = yield* Effect.findFirst(
            Array.map(searchPath(dir), (parent) => path.join(parent, "node_modules", name)),
            (candidate) => fs.exists(path.join(candidate, "package.json")),
          ).pipe(
            Effect.flatMap((candidate) =>
              Effect.fromOption(
                candidate,
                () =>
                  new IndexFailed({
                    reason: `${name} is not installed for ${shown(dir)}; run pnpm install`,
                  }),
              ),
            ),
          );
          const { version } = yield* fs
            .readFileString(path.join(found, "package.json"))
            .pipe(Effect.flatMap(decodeInstalled));
          if (version !== pin) {
            return yield* fail(
              `${shown(dir)} pins ${name}@${pin} but ${version} is installed; run pnpm install`,
            );
          }
          // pnpm links each workspace's copy into the store, so two links name one copy when their real paths agree.
          const real = yield* fs.realPath(found);
          return { name, version, dir: found, real };
        }),
      );
    }),
  );
  const byName = Array.groupBy(Array.flatten(declared), (pkg) => pkg.name);
  const packages = yield* Effect.forEach(Record.toEntries(byName), ([name, copies]) => {
    const first = Array.headNonEmpty(copies);
    return Option.match(
      Array.findFirst(copies, (copy) => copy.real !== first.real),
      {
        onNone: () => Effect.succeed(first),
        onSome: (other) =>
          fail(`${name} resolves to two copies: ${shown(first.real)} and ${shown(other.real)}`),
      },
    );
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
          String.endsWith(".d.ts")(file) &&
          path.basename(file) !== "index.d.ts" &&
          !Array.contains(String.split(file, path.sep), "internal")
            ? Result.succeed(String.slice(0, -".d.ts".length)(file))
            : Result.failVoid,
        ),
        Order.String,
      );
      const rows = yield* Effect.forEach(
        modules,
        Effect.fnUntraced(function* (module) {
          const declarations = yield* fs.readFileString(path.join(dist, `${module}.d.ts`));
          const lines = String.split(declarations, "\n");
          const count = Array.countBy(lines, (line) => exported.test(line));
          // The compiler drops a module's leading JSDoc when imports follow it, so read the shipped source first.
          const source = path.join(pkg.dir, "src", `${module}.ts`);
          const sourceText = (yield* fs.exists(source)) ? yield* fs.readFileString(source) : "";
          const sourceSummary = summaryOf(sourceText);
          // A module that only forwards another one has no declarations of its own; name where they live.
          const forwarded = Array.map(
            Array.fromIterable(String.matchAll(/^export \* from "([^"]+)"/gm)(declarations)),
            (match) => `\`${match[1]}\``,
          );
          const summary = pipe(
            [
              sourceSummary,
              summaryOf(declarations),
              Array.isReadonlyArrayNonEmpty(forwarded)
                ? `Re-exports ${Array.join(forwarded, ", ")}.`
                : "",
            ],
            Array.findFirst(String.isNonEmpty),
            Option.getOrElse(() => ""),
          );
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
      const exports = Number.sumAll(Array.map(rows, ({ count }) => count));
      return {
        rows,
        total: `| ${pkg.name} | ${pkg.version} | ${rows.length} | ${exports} | \`${location}/dist\` |`,
        section: Array.flatten([
          [
            `## ${pkg.name}@${pkg.version}`,
            "",
            `Declarations: \`${location}/dist/<module>.d.ts\`. Guides: ${Array.join(
              Array.map(guides, (guide) => `\`${location}/${guide}\``),
              ", ",
            )}.`,
            "",
            "| Module | Exports | Lines | Summary |",
            "| --- | ---: | ---: | --- |",
          ],
          Array.map(rows, ({ row }) => row),
          [""],
        ]),
      };
    }),
  );
  const withModules = Array.filter(indexed, ({ rows }) => Array.isReadonlyArrayNonEmpty(rows));
  if (!Array.isReadonlyArrayNonEmpty(withModules))
    return yield* fail("No installed Effect package has declaration files");

  const header = [
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
  ];
  const index = Array.join(
    Array.flatten([
      header,
      Array.map(withModules, ({ total }) => total),
      [""],
      Array.flatMap(withModules, ({ section }) => section),
    ]),
    "\n",
  );

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
