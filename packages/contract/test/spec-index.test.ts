import { expect, it } from "@effect/vitest";
import { Exit, Schema } from "effect";

import repoSpecIndex from "../../../.cairn/spec.json" with { type: "json" };
import { IndexedSection, SpecIndex, SpecIndexJson } from "../src/index.ts";

const encode = Schema.encodeSync(SpecIndexJson);
const decode = Schema.decodeUnknownSync(SpecIndexJson);
const refused = (schema: Schema.Decoder<unknown>, input: unknown) =>
  Exit.isFailure(Schema.decodeUnknownExit(schema)(input));

const requirement = { id: "spec.format#r1", level: "must", text: "Keys come before prose." };
const test = { id: "spec.format#t1", kind: "property", text: "Parsing round-trips." };
const decision = { id: "spec.format#d1", text: "IDs are explicit.", why: null };
const artifact = {
  description: "Parses a document into sections.",
  id: "spec.format#function:sections-of",
  kind: "function",
  location: null,
  name: "sectionsOf",
};
const field = { description: "", name: "id", optional: false, type: "SectionId" };

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const section = {
  artifacts: [artifact],
  children: [],
  context: ["prd.goal"],
  decisions: [decision],
  defers: [],
  dependsOn: ["spec.scope"],
  files: ["packages/core/src/sections.ts"],
  human: false,
  id: "spec.format",
  implements: ["prd.repo-layout"],
  level: 2,
  line: 7,
  parent: "spec.cairn-mvp-spec",
  requirements: [requirement],
  summary: "Sets the format of a spec section.",
  tasks: ["t17"],
  tests: [test],
  title: "Format",
  writtenFrom: { body: null, prd: { "prd.repo-layout": HASH } },
};
const index = {
  manifest: ".cairn/manifest.json",
  prd: ".cairn/prd.md",
  sections: [section],
  source: ".cairn/spec.md",
  version: 1,
};

/** Whether `section` with `patch` over it is refused. */
const refusedSection = (patch: Record<string, unknown>) =>
  refused(IndexedSection, { ...section, ...patch });

it("this repo's .cairn/spec.json decodes", () => {
  expect(refused(SpecIndex, repoSpecIndex)).toBe(false);
});

it.prop("a spec index survives a round trip through JSON", [SpecIndex], ([specIndex]) => {
  // Compare the JSON text: JSON has no -0, so a generated -0 would fail toEqual for no real reason.
  const json = encode(specIndex);
  expect(encode(decode(json))).toBe(json);
});

it("the example index and section decode, so each refusal below is its patch's doing", () => {
  expect(refused(SpecIndex, index)).toBe(false);
  expect(refusedSection({})).toBe(false);
});

it("refuses a version other than 1 and a missing field", () => {
  expect(refused(SpecIndex, { ...index, version: 2 })).toBe(true);
  expect(refusedSection({ summary: undefined })).toBe(true);
  expect(refusedSection({ decisions: [{ id: decision.id, text: decision.text }] })).toBe(true);
});

it("refuses a section id under the wrong document", () => {
  expect(refusedSection({ id: "prd.goal" })).toBe(true);
  expect(refusedSection({ parent: "prd.goal" })).toBe(true);
  expect(refusedSection({ implements: ["spec.scope"] })).toBe(true);
  expect(refusedSection({ context: ["spec.scope"] })).toBe(true);
  expect(refusedSection({ defers: ["spec.scope"] })).toBe(true);
  expect(refusedSection({ dependsOn: ["prd.goal"] })).toBe(true);
  expect(refusedSection({ children: ["prd.goal"] })).toBe(true);
});

it("writtenFrom takes a hash or null for the body, and refuses what is not a SHA-256 in hex", () => {
  const hash = HASH;
  expect(refusedSection({ writtenFrom: { body: hash, prd: {} } })).toBe(false);
  expect(refusedSection({ writtenFrom: { body: "abc", prd: {} } })).toBe(true);
  expect(refusedSection({ writtenFrom: { body: null, prd: { "prd.goal": "ABC" } } })).toBe(true);
  expect(refusedSection({ writtenFrom: undefined })).toBe(true);
  expect(refusedSection({ writtenFrom: { prd: {} } })).toBe(true);
});

it("refuses a level or line below 1", () => {
  expect(refusedSection({ level: 0 })).toBe(true);
  expect(refusedSection({ line: 0 })).toBe(true);
  expect(refusedSection({ line: 1.5 })).toBe(true);
});

it("refuses a requirement, test or decision whose id is another kind's", () => {
  expect(refusedSection({ requirements: [{ ...requirement, id: test.id }] })).toBe(true);
  expect(refusedSection({ tests: [{ ...test, id: decision.id }] })).toBe(true);
  expect(refusedSection({ decisions: [{ ...decision, id: requirement.id }] })).toBe(true);
  expect(refusedSection({ requirements: [{ ...requirement, id: "spec.format#r0" }] })).toBe(true);
  expect(refusedSection({ requirements: [{ ...requirement, id: "prd.goal#r1" }] })).toBe(true);
});

it("refuses a requirement level and a test kind that do not exist", () => {
  expect(refusedSection({ requirements: [{ ...requirement, level: "shall" }] })).toBe(true);
  expect(refusedSection({ tests: [{ ...test, kind: "unit" }] })).toBe(true);
});

it("an artifact takes fields, a signature and values, and refuses a kind that does not exist", () => {
  const full = { ...artifact, fields: [field], signature: "sectionsOf(markdown)", values: ["a"] };
  expect(refusedSection({ artifacts: [full] })).toBe(false);
  expect(refusedSection({ artifacts: [{ ...artifact, kind: "widget" }] })).toBe(true);
  expect(refusedSection({ artifacts: [{ ...artifact, id: "spec.format#r1" }] })).toBe(true);
  expect(refusedSection({ artifacts: [{ ...artifact, location: undefined }] })).toBe(true);
});

it("refuses an artifact field that is a bare name", () => {
  expect(refusedSection({ artifacts: [{ ...artifact, fields: ["id"] }] })).toBe(true);
});
