// Index the exports of the core `effect` modules (Array, Order, Effect, Schema, ...) for agents.
// Each row names one export, the first sentence of its JSDoc and its line range in
// the installed declaration file, so a search by name or intent leads straight to
// the source. Nothing is copied or fetched: the declarations stay in node_modules.
//
//   node scripts/effect-api/index-effect-core.ts          write .agent_sources/effect/core-index.md
//   node scripts/effect-api/index-effect-core.ts --check  fail when the index does not match the installed effect

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
  Predicate,
  Runtime,
  Schema,
  String,
} from "effect";
import { Command, Flag } from "effect/cli";

import { replaceFile } from "../../packages/cli/src/atomic-write.ts";
import { escapeCell } from "../agent-sources/markdown.ts";

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
// The prose runs from the first non-empty line to the next blank line or tag.
const summarize = (block: ReadonlyArray<string>) => {
  const prose = pipe(
    block,
    Array.map((raw) => pipe(raw, String.replace(/^\s*\/?\*+\/?\s?/, ""), String.trim)),
    Array.dropWhile(String.isEmpty),
    Array.takeWhile(
      (line) =>
        String.isNonEmpty(line) && !String.startsWith("@")(line) && !String.startsWith("**")(line),
    ),
  );
  const text = pipe(prose, Array.join(" "), escapeCell);
  const sentence = pipe(
    String.search(text, /\.(\s|$)/),
    Option.match({ onNone: () => text, onSome: (end) => String.slice(0, end + 1)(text) }),
  );
  return String.length(sentence) > 140 ? `${String.takeLeft(sentence, 137)}...` : sentence;
};

interface Export {
  readonly name: string;
  readonly start: number;
  readonly doc: ReadonlyArray<string>;
}

// The index of the last of `lines` up to `end` that `test` accepts, or 0 when none does.
const lastAtOrBefore = (
  lines: ReadonlyArray<string>,
  end: number,
  test: (line: string) => boolean,
) =>
  pipe(
    Array.take(lines, end + 1),
    Array.findLastIndex(test),
    Option.getOrElse(() => 0),
  );

// Every export of one declaration file, with the line its JSDoc starts on.
const exportsOf = (lines: ReadonlyArray<string>) => {
  const declared = Array.getSomes(
    Array.map(lines, (line, i) =>
      pipe(
        line,
        String.match(declaration),
        Option.flatMap(Array.get(1)),
        Option.map((name): Export => {
          const documented = pipe(
            Array.get(lines, i - 1),
            Option.exists((previous) => String.trim(previous) === "*/"),
          );
          const start = documented
            ? lastAtOrBefore(lines, i, (l) => pipe(l, String.trimStart, String.startsWith("/**")))
            : i;
          return { name, start: start + 1, doc: Array.drop(Array.take(lines, i), start) };
        }),
      ),
    ),
  );
  // A name that is a reserved word (try, catch, void) is declared as `try_` and exported in an
  // `export { /** doc */ try_ as try }` block, with its JSDoc inside the block.
  const renamed = Array.getSomes(
    Array.map(lines, (line, i) =>
      /^export \{\s*$/.test(line)
        ? pipe(
            Array.drop(lines, i + 1),
            Array.findFirstIndex((next) => /\bas ([A-Za-z_$][\w$]*)\s*\};?\s*$/.test(next)),
            Option.flatMap((offset) => {
              const close = i + 1 + offset;
              return pipe(
                Array.get(lines, close),
                Option.flatMap(String.match(/([A-Za-z_$][\w$]*) as ([A-Za-z_$][\w$]*)/)),
                Option.flatMap(([, local, name]) =>
                  Predicate.isNotUndefined(local) && Predicate.isNotUndefined(name)
                    ? Option.some({ local, name, close })
                    : Option.none(),
                ),
              );
            }),
            Option.map(({ local, name, close }): Export => {
              const declaredLocal = new RegExp(
                `^declare (?:const|function|class) ${String.replace("$", "\\$")(local)}\\b`,
              );
              const start = lastAtOrBefore(lines, i, (l) => declaredLocal.test(l));
              return { name, start: start + 1, doc: Array.drop(Array.take(lines, close), i + 1) };
            }),
          )
        : Option.none(),
    ),
  );
  return Array.sort(
    Array.appendAll(declared, renamed),
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
    Array.filter(listing, (file) => String.endsWith(".d.ts")(file) && file !== "index.d.ts"),
    Order.String,
  );
  const modules = yield* Effect.forEach(
    files,
    Effect.fnUntraced(function* (file) {
      const module = String.slice(0, -".d.ts".length)(file);
      const text = yield* fs.readFileString(path.join(dist, file));
      const lines = String.split(text, "\n");
      const exports = exportsOf(lines);
      return Array.map(exports, (e, i) => {
        const end = pipe(
          Array.get(exports, i + 1),
          Option.match({ onNone: () => lines.length, onSome: (next) => next.start - 1 }),
        );
        return `| ${module} | ${e.name} | ${e.start} | ${end} | ${summarize(e.doc)} |`;
      });
    }),
  );
  const rows = Array.flatten(modules);

  const header = [
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
  ];
  const index = Array.join(Array.flatten([header, rows, [""]]), "\n");

  const target = path.join(repo, INDEX);
  if (check) {
    const current = (yield* fs.exists(target)) ? yield* fs.readFileString(target) : "";
    if (current !== index) {
      return yield* fail(`${INDEX} does not match effect@${version}; run ${REFRESH}`);
    }
    return `${INDEX} matches effect@${version} (${rows.length} exports)`;
  }
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* replaceFile(target, index);
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
