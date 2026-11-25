import { readFileSync } from "node:fs";

import { EventJson, Manifest } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Schema, String, pipe } from "effect";

import repoManifest from "../../../.cairn/manifest.json" with { type: "json" };
import { derive } from "../src/index.ts";

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const manifest = Schema.decodeUnknownSync(Manifest)(repoManifest);
const events = pipe(
  repo(".cairn/events.jsonl"),
  String.split("\n"),
  Array.filter(String.isNonEmpty),
  Array.map((line) => Schema.decodeUnknownSync(EventJson)(line)),
);

it("this repo's events land every task its manifest records as finished, with no commits", () => {
  const derived = derive(manifest, [], { humanPaths: [] }, events, []);
  const finished = Array.filter(derived.tasks, ({ id }) =>
    Array.some(
      manifest.tasks,
      (task) => task.id === id && (task.status === "done" || task.status === "landed"),
    ),
  );
  expect(Array.isReadonlyArrayNonEmpty(finished)).toBe(true);
  expect(Array.map(finished, ({ id, status }) => ({ id, status }))).toStrictEqual(
    Array.map(finished, ({ id }) => ({ id, status: "landed" })),
  );
  expect(Array.filter(derived.warnings, ({ kind }) => kind === "unknown-task")).toStrictEqual([]);
});
