import { Event, EventJson, Manifest } from "@cairn/contract";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Array, Effect, FileSystem, Option, Path, Record, Schema, String } from "effect";

import { MainCheckout } from "../src/main-checkout.ts";
import {
  loadEvents,
  loadManifest,
  loadPrd,
  loadSpec,
  loadSpecIndex,
  MalformedFile,
  MissingFile,
} from "../src/workspace.ts";

const ManifestJson = Schema.fromJsonString(Manifest);
const encodeManifest = Schema.encodeSync(ManifestJson);
const encodeSync = Schema.encodeSync(EventJson);
const encodeEvent = (event: Event) => encodeSync(event);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Runs `effect` against a fresh main checkout whose `.cairn/` holds `files`. */
const inWorkspace = <A, E>(
  files: Record<string, string>,
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | MainCheckout>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, ".cairn"), { recursive: true });
      yield* Effect.forEach(Record.toEntries(files), ([name, content]) =>
        fs.writeFileString(path.join(root, ".cairn", name), content),
      );
      return yield* effect.pipe(Effect.provide(MainCheckout.fixed(root)));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const failureOf = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect);

/** The failure of `effect`, which has to be a `MalformedFile`. */
const malformedOf = <A, E>(effect: Effect.Effect<A, E>) =>
  failureOf(effect).pipe(
    Effect.filterOrFail(
      (error): error is Extract<E, MalformedFile> => Schema.is(MalformedFile)(error),
      () => new Error("expected a MalformedFile failure"),
    ),
    Effect.orDie,
  );

const repoFile = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const here = yield* path.fromFileUrl(new URL("../../../.cairn/", import.meta.url));
    return yield* fs.readFileString(path.join(here, name));
  }).pipe(Effect.provide(NodeServices.layer));

it.effect.prop("a manifest written to disk loads back equal", [Manifest], ([manifest]) =>
  Effect.gen(function* () {
    const loaded = yield* inWorkspace({ "manifest.json": encodeManifest(manifest) }, loadManifest);
    expect(loaded).toEqual(manifest);
  }),
);

it.effect.prop(
  "events written as JSONL load back equal, in order",
  [Schema.Array(Event)],
  ([events]) =>
    Effect.gen(function* () {
      const text = Array.join(Array.map(events, encodeEvent), "\n");
      const loaded = yield* inWorkspace({ "events.jsonl": `${text}\n` }, loadEvents);
      expect(loaded).toEqual(events);
    }),
);

it.effect.prop(
  "a malformed event names events.jsonl, its line and the field path",
  [Schema.Array(Event), Event],
  ([events, event]) =>
    Effect.gen(function* () {
      const bad = String.replace('"status":"', '"status":"not-a-status-')(encodeEvent(event));
      const lines = Array.appendAll(Array.map(events, encodeEvent), [bad]);
      // A blank first line still counts toward the physical line number.
      const text = `\n${Array.join(lines, "\n")}\n`;
      const malformed = yield* malformedOf(inWorkspace({ "events.jsonl": text }, loadEvents));
      expect(String.endsWith("/.cairn/events.jsonl")(malformed.file)).toBe(true);
      expect(malformed.line).toEqual(Option.some(events.length + 2));
      expect(malformed.path).toBe("status");
    }),
);

it.effect.prop(
  "a manifest with a wrong field names manifest.json and the path",
  [Manifest],
  ([manifest]) =>
    Effect.gen(function* () {
      const encoded = Schema.encodeSync(Manifest)(manifest);
      const [first, ...rest] = encoded.tasks;
      const broken = { ...encoded, tasks: Array.prepend(rest, { ...first, reasoning: "extreme" }) };
      const malformed = yield* malformedOf(
        inWorkspace({ "manifest.json": encodeJson(broken) }, loadManifest),
      );
      expect(String.endsWith("/.cairn/manifest.json")(malformed.file)).toBe(true);
      expect(malformed.line).toEqual(Option.none());
      expect(malformed.path).toBe("tasks.0.reasoning");
    }),
);

it.effect("text that is not JSON is malformed with no field path", () =>
  Effect.gen(function* () {
    const malformed = yield* malformedOf(
      inWorkspace({ "manifest.json": "{not json" }, loadManifest),
    );
    expect(malformed.path).toBe("");
  }),
);

it.effect("absent files: required ones are MissingFile, optional ones are none", () =>
  Effect.gen(function* () {
    const missing = [
      yield* failureOf(inWorkspace({}, loadPrd)),
      yield* failureOf(inWorkspace({}, loadSpec)),
      yield* failureOf(inWorkspace({}, loadManifest)),
    ];
    Array.forEach(missing, (error) => expect(error).toBeInstanceOf(MissingFile));
    const none = yield* inWorkspace({}, loadEvents);
    const empty = yield* inWorkspace({ "events.jsonl": "" }, loadEvents);
    const blank = yield* inWorkspace({ "events.jsonl": "\n\n" }, loadEvents);
    const index = yield* inWorkspace({}, loadSpecIndex);
    expect([none, empty, blank]).toEqual([[], [], []]);
    expect(index).toEqual(Option.none());
  }),
);

it.effect("prd.md and spec.md load as text", () =>
  Effect.gen(function* () {
    const prd = yield* inWorkspace({ "prd.md": "# PRD\n" }, loadPrd);
    const spec = yield* inWorkspace({ "spec.md": "# Spec\n" }, loadSpec);
    expect([prd, spec]).toEqual(["# PRD\n", "# Spec\n"]);
  }),
);

it.effect("this repo's own manifest.json and spec.json load", () =>
  Effect.gen(function* () {
    const files = {
      "manifest.json": yield* repoFile("manifest.json"),
      "spec.json": yield* repoFile("spec.json"),
    };
    const manifest = yield* inWorkspace(files, loadManifest);
    const index = yield* inWorkspace(files, loadSpecIndex);
    expect(manifest.feature).toBe("cairn-mvp");
    expect(Option.isSome(index)).toBe(true);
  }),
);
