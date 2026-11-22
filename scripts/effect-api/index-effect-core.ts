// Index the exports of the core `effect` modules (Array, Order, Effect, Schema, ...) for agents.
// Each row names one export, the first sentence of its JSDoc and its line range in
// the installed declaration file, so a search by name or intent leads straight to
// the source. Nothing is copied or fetched: the declarations stay in node_modules.
//
//   node scripts/effect-api/index-effect-core.ts          write .agent_sources/effect/core-index.md
//   node scripts/effect-api/index-effect-core.ts --check  fail when the index does not match the installed effect

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Array, Effect, FileSystem, Layer, Logger, Order, Path, Runtime, Schema } from "effect";
import { Command, Flag } from "effect/cli";

const INDEX = ".agent_sources/effect/core-index.md";
const REFRESH = "node scripts/effect-api/index-effect-core.ts";

// The program returns what it did for the command to log. Each failure logs its own message once (see the command below), so the runtime is told not to print it again.
class IndexFailed extends Schema.TaggedError<IndexFailed>()("IndexFailed", {
  reason: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return this.reason;
  }
}

const fail = (reason: string) => Effect.fail(new IndexFailed({ reason }));

const decodeVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

const declaration =
  /^export (?:declare )?(?:const|function|type|interface|class|namespace|enum) ([A-Za-z_$][\w$]*)/;

// The first sentence of a JSDoc block, flattened to one line and safe inside a table cell.
const summarize = (block: ReadonlyArray<string>) => {
  const prose: string[] = [];
  for (const raw of block) {
    const line = raw.replace(/^\s*\/?\*+\/?\s?/, "").trim();
    if (line.startsWith("@") || line.startsWith("**")) break;
    if (line === "" && prose.length) break;
    if (line) prose.push(line);
  }
  const text = prose.join(" ").replaceAll("|", "\\|");
  const end = text.search(/\.(\s|$)/);
  const sentence = end === -1 ? text : text.slice(0, end + 1);
  return sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence;
};

interface Export {
  readonly name: string;
  readonly start: number;
  readonly doc: ReadonlyArray<string>;
}

// Every export of one declaration file, with the line its JSDoc starts on.
const exportsOf = (lines: ReadonlyArray<string>) => {
  const found: Export[] = [];
  lines.forEach((line, i) => {
    const match = declaration.exec(line);
    if (!match?.[1]) return;
    let start = i;
    if (lines[i - 1]?.trim() === "*/") {
      while (start > 0 && !lines[start]?.trimStart().startsWith("/**")) start--;
    }
    found.push({ name: match[1], start: start + 1, doc: start < i ? lines.slice(start, i) : [] });
  });
  // A name that is a reserved word (try, catch, void) is declared as `try_` and exported in an
  // `export { /** doc */ try_ as try }` block, with its JSDoc inside the block.
  lines.forEach((line, i) => {
    if (!/^export \{\s*$/.test(line)) return;
    let close = i + 1;
    while (close < lines.length && !/\bas ([A-Za-z_$][\w$]*)\s*\};?\s*$/.test(lines[close] ?? "")) {
      close++;
    }
    const [, local, name] =
      /([A-Za-z_$][\w$]*) as ([A-Za-z_$][\w$]*)/.exec(lines[close] ?? "") ?? [];
    if (!local || !name) return;
    const declared = new RegExp(
      `^declare (?:const|function|class) ${local.replace("$", "\\$")}\\b`,
    );
    let start = i;
    while (start > 0 && !declared.test(lines[start] ?? "")) start--;
    found.push({ name, start: start + 1, doc: lines.slice(i + 1, close) });
  });
  return Array.sort(
    found,
    Order.mapInput(Order.Number, (e: Export) => e.start),
  );
};

const indexCore = Effect.fn("indexEffectCore")(function* ({ check }: { check: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const effect = path.join(repo, "node_modules", "effect");
  if (!(yield* fs.exists(path.join(effect, "package.json")))) {
    return yield* fail("effect is not installed at the repository root; run pnpm install");
  }
  const { version } = yield* fs
    .readFileString(path.join(effect, "package.json"))
    .pipe(Effect.flatMap(decodeVersion));
  const dist = path.join(effect, "dist");
  const listing = yield* fs.readDirectory(dist);
  const files = Array.sort(
    Array.filter(listing, (file) => file.endsWith(".d.ts") && file !== "index.d.ts"),
    Order.String,
  );
  const modules = yield* Effect.forEach(
    files,
    Effect.fnUntraced(function* (file) {
      const module = file.slice(0, -".d.ts".length);
      const lines = (yield* fs.readFileString(path.join(dist, file))).split("\n");
      const exports = exportsOf(lines);
      return Array.map(exports, (e, i) => {
        const end = (exports[i + 1]?.start ?? lines.length + 1) - 1;
        return `| ${module} | ${e.name} | ${e.start} | ${end} | ${summarize(e.doc)} |`;
      });
    }),
  );
  const rows = Array.flatten(modules);

  const index = [
    "# effect core API index",
    "",
    `Generated from the type declarations of the installed \`effect@${version}\` by \`scripts/effect-api/index-effect-core.ts\`. Do not edit it; \`pnpm check:effect-api\` fails when it is stale.`,
    "",
    "Each row is one export of `import { <Module> } from 'effect'`. Its JSDoc, examples, and signature are lines Start to End of `node_modules/effect/dist/<Module>.d.ts`.",
    "",
    "Search by name or by intent, then read that range:",
    "",
    "```sh",
    "rg -n '^\\| Array \\| (sort|dedupe|groupBy) \\|' .agent_sources/effect/core-index.md",
    "rg -in 'duplicate|sorts' .agent_sources/effect/core-index.md",
    "sed -n '<Start>,<End>p' node_modules/effect/dist/<Module>.d.ts",
    "```",
    "",
    "For a native pattern and its Effect replacement, start with [native-to-effect.md](native-to-effect.md).",
    "",
    "| Module | Export | Start | End | Summary |",
    "| --- | --- | ---: | ---: | --- |",
    ...rows,
    "",
  ].join("\n");

  const target = path.join(repo, INDEX);
  if (check) {
    const current = (yield* fs.exists(target)) ? yield* fs.readFileString(target) : "";
    if (current !== index) {
      return yield* fail(`${INDEX} does not match effect@${version}; run ${REFRESH}`);
    }
    return `${INDEX} matches effect@${version} (${rows.length} exports)`;
  }
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(target, index);
  return `Indexed effect@${version} in ${INDEX}: ${files.length} modules, ${rows.length} exports`;
});

const command = Command.make(
  "index-effect-core",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(`Fail when ${INDEX} does not match the installed effect`),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    indexCore(input).pipe(
      Effect.flatMap(Effect.logInfo),
      Effect.tapErrorTag("IndexFailed", (error) => Effect.logError(error.message)),
    ),
).pipe(Command.withDescription("Index the exports of the core effect modules"));

// Logs go to stderr.
const logger = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(logger, NodeServices.layer)),
  NodeRuntime.runMain,
);
