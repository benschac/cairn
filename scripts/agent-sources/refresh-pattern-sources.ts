// Cache and index the Ratstack reference documents.
// Downloads https://ratstack.sh/llms.txt and llms-full.txt, keeps their bytes,
// writes a topic index for each, and records their checksums in
// .agent_sources/sources.json, keeping its other entries. Nothing is written
// unless every document downloads and parses. Nothing runs this during install
// or build.
//
//   node scripts/agent-sources/refresh-pattern-sources.ts
//   node scripts/agent-sources/refresh-pattern-sources.ts --from-dir DIR --fetched-at ISO_TIMESTAMP
//
// --from-dir imports earlier downloads: DIR holds ratstack-llms.txt and
// ratstack-full.txt, and --fetched-at is when they were downloaded.

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Array,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Record,
  Runtime,
  Schema,
  String,
} from "effect";
import { Command, Flag } from "effect/cli";
import { Digest } from "effect/crypto";
import { FetchHttpClient, HttpClient } from "effect/http";

import { headingsOf, topicTable } from "./markdown.ts";

// Each expected failure logs its own message once (see the command below), so the runtime is told not to print it again.
class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return "--from-dir and --fetched-at go together: name the directory and when its files were downloaded";
  }
}

class UnexpectedDocument extends Schema.TaggedError<UnexpectedDocument>()("UnexpectedDocument", {
  id: Schema.String,
  reason: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message() {
    return `${this.id}: ${this.reason}`;
  }
}

interface Source {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  // The file name under --from-dir.
  readonly file: string;
  // Where the document and its index go, relative to .agent_sources.
  readonly document: string;
  readonly index: string;
}

const REGISTRY: ReadonlyArray<Source> = [
  {
    id: "ratstack-guide",
    title: "Ratstack agent guide",
    url: "https://ratstack.sh/llms.txt",
    file: "ratstack-llms.txt",
    document: "ratstack/guide.txt",
    index: "ratstack/guide-index.md",
  },
  {
    id: "ratstack",
    title: "Ratstack patterns and guidelines",
    url: "https://ratstack.sh/llms-full.txt",
    file: "ratstack-full.txt",
    document: "ratstack/docs.txt",
    index: "ratstack/index.md",
  },
];
const COMPATIBILITY =
  "Unversioned website snapshot. Cairn uses the same stack (Effect, XState, Foldkit, Alchemy, Cloudflare) at the versions its manifests pin; check the installed packages before applying an example.";
const TIMEOUT = Duration.seconds(30);
const HTML = /<!doctype html|<html[\s>]/i;

// sources.json, written with two-space indentation. The other entries are owned by other refresh scripts and kept as they are.
const SourcesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown), {
  space: 2,
});
const decodeSources = Schema.decodeEffect(SourcesJson);
const encodeSources = Schema.encodeEffect(SourcesJson);

const refresh = Effect.fn("refreshPatternSources")(function* ({
  fromDir,
  fetchedAt,
}: {
  fromDir: Option.Option<string>;
  fetchedAt: Option.Option<Date>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const http = yield* HttpClient.HttpClient;
  const client = HttpClient.filterStatusOk(http);
  const rootUrl = yield* path.fromFileUrl(new URL("../../.agent_sources/", import.meta.url));
  const root = path.resolve(rootUrl);

  if (Option.isSome(fromDir) !== Option.isSome(fetchedAt)) return yield* new UsageError();
  const imported = Option.isSome(fromDir);
  const at = yield* Option.match(fetchedAt, {
    onSome: (date) => Effect.succeed(DateTime.fromDateUnsafe(date)),
    onNone: () => DateTime.now,
  });

  const download = (source: Source) =>
    Option.match(fromDir, {
      onSome: (dir) => fs.readFile(path.join(dir, source.file)),
      onNone: () =>
        client.get(source.url).pipe(
          Effect.flatMap((response) => response.arrayBuffer),
          Effect.map((buffer) => new Uint8Array(buffer)),
          Effect.timeout(TIMEOUT),
        ),
    });

  const prepared = yield* Effect.forEach(
    REGISTRY,
    Effect.fnUntraced(function* (source) {
      const bytes = yield* download(source);
      const document = new TextDecoder().decode(bytes);
      if (String.isEmpty(String.trim(document)) || HTML.test(document)) {
        return yield* new UnexpectedDocument({
          id: source.id,
          reason: `expected Markdown from ${source.url}, received empty content or HTML`,
        });
      }
      const lines = String.split(document, "\n");
      const topics = headingsOf(lines);
      if (!Array.isReadonlyArrayNonEmpty(topics)) {
        return yield* new UnexpectedDocument({
          id: source.id,
          reason: `no headings found in ${source.url}`,
        });
      }
      const filename = path.basename(source.document);
      const index = [
        `# ${source.title} index`,
        "",
        `Source: ${source.url}`,
        "",
        `Line ranges refer to [${filename}](${filename}). Read [the Ratstack workflow](README.md) before applying examples.`,
        "",
        ...topicTable(topics, lines.length),
        "",
      ].join("\n");
      const sha256 = yield* digest.digestHex(Digest.sha256, bytes);
      return { source, bytes, index, sha256 };
    }),
  );

  const sourcesFile = path.join(root, "sources.json");
  const sources = (yield* fs.exists(sourcesFile))
    ? yield* fs.readFileString(sourcesFile).pipe(Effect.flatMap(decodeSources))
    : Record.empty<string, unknown>();
  const updated = Array.reduce(prepared, sources, (record, { source, bytes, sha256 }) =>
    Record.set(record, source.id, {
      url: source.url,
      fetchedAt: DateTime.formatIso(at),
      retrieval: imported ? "imported-download; timestamp supplied by caller" : "https",
      sha256,
      bytes: bytes.length,
      package: null,
      targetPackageVersion: null,
      upstreamVersion: null,
      upstreamRevision: null,
      compatibility: COMPATIBILITY,
      document: source.document,
      index: source.index,
    }),
  );
  const json = yield* encodeSources(updated);

  yield* Effect.forEach(
    prepared,
    Effect.fnUntraced(function* ({ source, bytes, index }) {
      yield* fs.makeDirectory(path.dirname(path.join(root, source.document)), { recursive: true });
      yield* fs.writeFile(path.join(root, source.document), bytes);
      yield* fs.writeFileString(path.join(root, source.index), index);
    }),
    { discard: true },
  );
  yield* fs.writeFileString(sourcesFile, `${json}\n`);
  return `Cached and indexed ${prepared.length} Ratstack references`;
});

const command = Command.make(
  "refresh-pattern-sources",
  {
    fromDir: Flag.Directory("from-dir", { mustExist: true }).pipe(
      Flag.withDescription(
        "Import ratstack-llms.txt and ratstack-full.txt from this directory instead of downloading",
      ),
      Flag.optional,
    ),
    fetchedAt: Flag.Date("fetched-at").pipe(
      Flag.withDescription("When the imported files were downloaded (ISO timestamp)"),
      Flag.optional,
    ),
  },
  (input) =>
    refresh(input).pipe(
      Effect.flatMap(Effect.logInfo),
      Effect.tapErrorTag(["UsageError", "UnexpectedDocument"], (error) =>
        Effect.logError(error.message),
      ),
    ),
).pipe(Command.withDescription("Cache and index the Ratstack reference documents"));

// Logs go to stderr so stdout stays free for results.
const logger = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(
    Layer.mergeAll(logger, NodeServices.layer, FetchHttpClient.layer, Digest.layerWebCrypto),
  ),
  NodeRuntime.runMain,
);
