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

// The backfill covers the tasks built before their commits carried trailers. A task built since lands from its
// Cairn-Task trailer on main, which this test does not read, so it needs no line here.
it("this repo's events land every task they name, with no commits, and name only finished tasks", () => {
  const derived = derive(manifest, [], { humanPaths: [] }, events, []);
  const named = Array.dedupe(Array.map(events, ({ taskId }) => taskId));
  const finished = Array.filter(derived.tasks, ({ id }) => Array.contains(named, id));
  expect(Array.isReadonlyArrayNonEmpty(finished)).toBe(true);
  expect(
    Array.filter(manifest.tasks, ({ id, status }) =>
      Array.contains(named, id) ? status !== "done" && status !== "landed" : false,
    ),
  ).toStrictEqual([]);
  expect(Array.map(finished, ({ id, status }) => ({ id, status }))).toStrictEqual(
    Array.map(finished, ({ id }) => ({ id, status: "landed" })),
  );
  expect(Array.filter(derived.warnings, ({ kind }) => kind === "unknown-task")).toStrictEqual([]);
});
