import { expect, it } from "@effect/vitest";
import { Array, Result, Schema } from "effect";

import repoManifest from "../../../.cairn/manifest.json" with { type: "json" };
import { GateReason, Manifest, ManifestTask } from "../src/index.ts";

const decode = Schema.decodeUnknownResult(Manifest);
const encode = Schema.encodeSync(Manifest);
const ManifestJson = Schema.fromJsonString(Manifest);

/** Decodes `manifest` with its first task replaced by `patch` of that task's encoding. */
const refused = (
  manifest: Manifest,
  patch: (task: typeof ManifestTask.Encoded) => Record<string, unknown>,
) => {
  const encoded = encode(manifest);
  const [first, ...rest] = encoded.tasks;
  return Result.isFailure(decode({ ...encoded, tasks: Array.prepend(rest, patch(first)) }));
};

/** A patch that gives the task a required gate with `reasons`. */
const gate = (reasons: ReadonlyArray<string>) => (t: typeof ManifestTask.Encoded) => ({
  ...t,
  humanGate: { reasons, required: true },
});

it("this repo's .cairn/manifest.json decodes", () => {
  expect(Result.isSuccess(decode(repoManifest))).toBe(true);
});

it.prop("a manifest round-trips through JSON", [Manifest], ([manifest]) => {
  const json = Schema.encodeSync(ManifestJson)(manifest);
  expect(Schema.decodeSync(ManifestJson)(json)).toEqual(manifest);
});

it.prop("a generated manifest's own encoding decodes", [Manifest], ([manifest]) => {
  expect(refused(manifest, (task) => task)).toBe(false);
});

it.prop("refuses an empty task list", [Manifest], ([manifest]) => {
  expect(Result.isFailure(decode({ ...encode(manifest), tasks: [] }))).toBe(true);
});

it.prop("refuses a reasoning level or status that does not exist", [Manifest], ([manifest]) => {
  expect(refused(manifest, (t) => ({ ...t, reasoning: "extreme" }))).toBe(true);
  expect(refused(manifest, (t) => ({ ...t, status: "merged" }))).toBe(true);
});

it.prop("refuses a malformed branch", [Manifest], ([manifest]) => {
  expect(refused(manifest, (t) => ({ ...t, branch: "no-number" }))).toBe(true);
});

it.prop("refuses a malformed task id, section id and sha", [Manifest], ([manifest]) => {
  expect(refused(manifest, (t) => ({ ...t, id: "t 1" }))).toBe(true);
  expect(refused(manifest, (t) => ({ ...t, prdSections: ["spec.contract.manifest"] }))).toBe(true);
  expect(refused(manifest, (t) => ({ ...t, specSections: [] }))).toBe(true);
  expect(refused(manifest, (t) => ({ ...t, commits: ["abc123"] }))).toBe(true);
});

it.prop("accepts every gate reason and refuses others", [Manifest, GateReason], ([m, reason]) => {
  expect(refused(m, gate([reason]))).toBe(false);
  expect(refused(m, gate(["tag:robot"]))).toBe(true);
});

it("a gate reason is the human tag or a path glob", () => {
  expect(Schema.is(GateReason)("tag:human")).toBe(true);
  expect(Schema.is(GateReason)("path:**/*.sql")).toBe(true);
  expect(Schema.is(GateReason)("tag:robot")).toBe(false);
});

it.prop("refuses a version other than 1", [Manifest], ([manifest]) => {
  expect(Result.isFailure(decode({ ...encode(manifest), version: 2 }))).toBe(true);
});
