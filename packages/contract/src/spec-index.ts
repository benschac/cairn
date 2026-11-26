import { Effect, Schema } from "effect";
import { VariantSchema } from "effect/schema";

import {
  KEBAB,
  PrdSectionId,
  sectionPattern,
  SpecSectionId,
  StatementId,
  TaskId,
  TestId,
} from "./ids.ts";

/** The id of something a spec section holds: the section's id, `#`, then `suffix`. */
const itemId = (suffix: string) =>
  Schema.String.check(Schema.isPattern(sectionPattern("spec", `#${suffix}`)));

const NUMBER = String.raw`[1-9]\d*`;

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

/** A test the section asks for, with an id such as `spec.format#t1`. `proves` lists the done-when statements it proves. */
export const SpecTest = Schema.Struct({
  id: TestId,
  kind: SpecTestKind,
  proves: Schema.Array(StatementId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
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

/** A SHA-256 in hex: the hash of a section's body with trailing whitespace removed from each line. */
export const BodyHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("BodyHash"),
);
export type BodyHash = typeof BodyHash.Type;

/**
 * What a spec section was written from, set once when it is written or first indexed (see
 * `prd.planning.again`). `body` is null for a section a person wrote; `prd` holds the hash of each
 * PRD section it implements, as it was then.
 */
export const WrittenFrom = Schema.Struct({
  body: Schema.NullOr(BodyHash),
  prd: Schema.Record(PrdSectionId, BodyHash),
});
export type WrittenFrom = typeof WrittenFrom.Type;

/**
 * Who fills each field of a `spec.json` entry. `derived` is what code reads from `spec.md` and
 * `manifest.json`, with `writtenFrom`, recorded when the section is written; `prose` is what the
 * planner extracts from the section's text; `entry`, the default, is the whole entry.
 */
const Entry = VariantSchema.make({
  defaultVariant: "entry",
  variants: ["entry", "derived", "prose"],
});

/** A field code fills. */
const derived = Entry.FieldOnly(["entry", "derived"]);
/** A field the planner fills. */
const prose = Entry.FieldOnly(["entry", "prose"]);

const SectionFields = Entry.Struct({
  artifacts: prose(Schema.Array(Artifact)),
  children: derived(Schema.Array(SpecSectionId)),
  context: derived(Schema.Array(PrdSectionId)),
  decisions: prose(Schema.Array(Decision)),
  defers: derived(Schema.Array(PrdSectionId)),
  dependsOn: derived(Schema.Array(SpecSectionId)),
  files: derived(Schema.Array(Schema.String)),
  human: derived(Schema.Boolean),
  id: derived(SpecSectionId),
  implements: derived(Schema.Array(PrdSectionId)),
  /** The body whose prose was indexed. Older entries omit the hash. */
  indexedFrom: derived(Schema.optionalKey(BodyHash)),
  level: derived(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  line: derived(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  parent: derived(Schema.NullOr(SpecSectionId)),
  requirements: prose(Schema.Array(Requirement)),
  summary: prose(Schema.String),
  tasks: derived(Schema.Array(TaskId)),
  tests: prose(Schema.Array(SpecTest)),
  title: derived(Schema.String),
  writtenFrom: derived(WrittenFrom),
});

/** One spec section in `spec.json`: its derived fields and its prose. */
export const IndexedSection = Entry.extract(SectionFields, "entry");
export type IndexedSection = typeof IndexedSection.Type;

/** The fields of an entry that code derives from `spec.md` and `manifest.json`, and `writtenFrom`. */
export const DerivedSection = Entry.extract(SectionFields, "derived");
export type DerivedSection = typeof DerivedSection.Type;

/** The prose fields of an entry, which the planner's `index` call asks the model for. */
export const IndexProse = Entry.extract(SectionFields, "prose");
export type IndexProse = typeof IndexProse.Type;

/** What a task proves: each statement it traces, whether it is a draft and the tests that prove it. */
export const IndexedTask = Schema.Struct({
  id: TaskId,
  statements: Schema.Array(
    Schema.Struct({
      draft: Schema.Boolean,
      id: StatementId,
      provedBy: Schema.Array(TestId),
    }),
  ),
});
export type IndexedTask = typeof IndexedTask.Type;

/** `spec.json`: a structured copy of `spec.md`, its sections in document order. */
export const SpecIndex = Schema.Struct({
  manifest: Schema.NonEmptyString,
  prd: Schema.NonEmptyString,
  sections: Schema.Array(IndexedSection),
  source: Schema.NonEmptyString,
  /** Empty in an index written before statements existed. */
  tasks: Schema.Array(IndexedTask).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  version: Schema.Literal(1),
});
export type SpecIndex = typeof SpecIndex.Type;

export const SpecIndexJson = Schema.fromJsonString(SpecIndex);
