import { readFileSync } from "node:fs";

import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";

import { GateReason, Manifest, ManifestTask } from "../src/index.ts";

const decode = Schema.decodeUnknownResult(Manifest);
const encode = Schema.encodeSync(Manifest);

const repoJson = readFileSync(new URL("../../../.cairn/manifest.json", import.meta.url), "utf8");
const repoManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(repoJson);
const base = encode(repoManifest);

it("this repo's .cairn/manifest.json decodes", () => {
  expect(Result.isSuccess(decode(JSON.parse(repoJson)))).toBe(true);
});

it.prop("a manifest round-trips through its encoding", [Manifest], ([manifest]) => {
  expect(decode(JSON.parse(JSON.stringify(encode(manifest))))).toEqual(Result.succeed(manifest));
});

const refused = (patch: (task: object) => object) => {
  const [first, ...rest] = base.tasks;
  return Result.isFailure(decode({ ...base, tasks: [patch(first), ...rest] }));
};

it("refuses an empty task list", () => {
  expect(Result.isFailure(decode({ ...base, tasks: [] }))).toBe(true);
});

it("refuses a reasoning level that does not exist", () => {
  expect(refused((t) => ({ ...t, reasoning: "extreme" }))).toBe(true);
});

it("refuses a status that does not exist", () => {
  expect(refused((t) => ({ ...t, status: "merged" }))).toBe(true);
});

it("refuses a malformed branch", () => {
  expect(refused((t) => ({ ...t, branch: "no-number" }))).toBe(true);
});

it("refuses a malformed task id, section id and sha", () => {
  expect(refused((t) => ({ ...t, id: "t 1" }))).toBe(true);
  expect(refused((t) => ({ ...t, prdSections: ["spec.contract.manifest"] }))).toBe(true);
  expect(refused((t) => ({ ...t, specSections: [] }))).toBe(true);
  expect(refused((t) => ({ ...t, commits: ["abc123"] }))).toBe(true);
});

it("refuses a bad gate reason", () => {
  expect(refused((t) => ({ ...t, humanGate: { reasons: ["tag:robot"], required: true } }))).toBe(
    true,
  );
  expect(Schema.is(GateReason)("tag:human")).toBe(true);
  expect(Schema.is(GateReason)("path:**/*.sql")).toBe(true);
});

it("refuses a version other than 1", () => {
  expect(Result.isFailure(decode({ ...base, version: 2 }))).toBe(true);
});

it("a task schema is exported", () => {
  expect(Schema.is(ManifestTask)({})).toBe(false);
});
