import { Schema } from "effect";

import { PrdSectionId, sectionPattern, SpecSectionId, TaskId } from "./ids.ts";

/** The id of something a spec section holds: the section's id, `#`, then `suffix`. */
const itemId = (suffix: string) =>
  Schema.String.check(Schema.isPattern(sectionPattern("spec", `#${suffix}`)));

const NUMBER = String.raw`[1-9]\d*`;
const KEBAB = "[a-z0-9]+(?:-[a-z0-9]+)*";

export const RequirementLevel = Schema.Literals(["must", "must-not", "should", "may"]);
export type RequirementLevel = typeof RequirementLevel.Type;

/** Something the section says the code must, should or may do, with an id such as `spec.format#r1`. */
export const Requirement = Schema.Struct({
  id: itemId(`r${NUMBER}`),
  level: RequirementLevel,
  text: Schema.NonEmptyString,
});
export type Requirement = typeof Requirement.Type;

export const SpecTestKind = Schema.Literals([
  "check",
  "example",
  "property",
  "scene",
  "integration",
  "mutation",
]);
export type SpecTestKind = typeof SpecTestKind.Type;

/** A test the section asks for, with an id such as `spec.format#t1`. */
export const SpecTest = Schema.Struct({
  id: itemId(`t${NUMBER}`),
  kind: SpecTestKind,
  text: Schema.NonEmptyString,
});
export type SpecTest = typeof SpecTest.Type;

/** A choice the section records, with an id such as `spec.format#d1`. `why` is null when the spec gives no reason. */
export const Decision = Schema.Struct({
  id: itemId(`d${NUMBER}`),
  text: Schema.NonEmptyString,
  why: Schema.NullOr(Schema.String),
});
export type Decision = typeof Decision.Type;

export const ArtifactKind = Schema.Literals([
  "command",
  "config-key",
  "file",
  "flag",
  "function",
  "library",
  "lint-rule",
  "machine-event",
  "machine-state",
  "message",
  "option",
  "route",
  "schema",
  "service",
  "status",
  "table",
  "type",
]);
export type ArtifactKind = typeof ArtifactKind.Type;

/** One field of a schema, type or table artifact. */
export const ArtifactField = Schema.Struct({
  description: Schema.String,
  name: Schema.NonEmptyString,
  optional: Schema.Boolean,
  type: Schema.String,
});
export type ArtifactField = typeof ArtifactField.Type;

/**
 * Something the section names that code will hold: a function, a schema, a route. Its id is
 * the section's id, `#`, the kind, `:` and a slug, such as `spec.lint#lint-rule:index-drift`.
 * `fields`, `signature` and `values` are there only for the kinds that have them.
 */
export const Artifact = Schema.Struct({
  description: Schema.String,
  fields: Schema.optionalKey(Schema.Array(ArtifactField)),
  id: itemId(`[a-z]+(?:-[a-z]+)*:${KEBAB}`),
  kind: ArtifactKind,
  location: Schema.NullOr(Schema.String),
  name: Schema.NonEmptyString,
  signature: Schema.optionalKey(Schema.String),
  values: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type Artifact = typeof Artifact.Type;

/**
 * One spec section in `spec.json`. Code derives the fields down to `tasks` from `spec.md` and
 * `manifest.json`; the planner extracts the rest from the section's prose.
 */
export const IndexedSection = Schema.Struct({
  artifacts: Schema.Array(Artifact),
  children: Schema.Array(SpecSectionId),
  context: Schema.Array(PrdSectionId),
  decisions: Schema.Array(Decision),
  defers: Schema.Array(PrdSectionId),
  dependsOn: Schema.Array(SpecSectionId),
  files: Schema.Array(Schema.String),
  human: Schema.Boolean,
  id: SpecSectionId,
  implements: Schema.Array(PrdSectionId),
  level: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  parent: Schema.NullOr(SpecSectionId),
  requirements: Schema.Array(Requirement),
  summary: Schema.String,
  tasks: Schema.Array(TaskId),
  tests: Schema.Array(SpecTest),
  title: Schema.String,
});
export type IndexedSection = typeof IndexedSection.Type;

/** `spec.json`: a structured copy of `spec.md`, its sections in document order. */
export const SpecIndex = Schema.Struct({
  manifest: Schema.NonEmptyString,
  prd: Schema.NonEmptyString,
  sections: Schema.Array(IndexedSection),
  source: Schema.NonEmptyString,
  version: Schema.Literal(1),
});
export type SpecIndex = typeof SpecIndex.Type;

export const SpecIndexJson = Schema.fromJsonString(SpecIndex);
