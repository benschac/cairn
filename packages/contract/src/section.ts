import { Schema } from "effect";

import { PrdSectionId, SectionId, SpecSectionId } from "./ids.ts";

/**
 * The keys a spec section lists before its prose (see `spec.format`): its own plus the ones it
 * inherits from the sections above it in the heading tree. All empty in the PRD.
 */
export const SectionKeys = Schema.Struct({
  context: Schema.Array(PrdSectionId),
  defers: Schema.Array(PrdSectionId),
  dependsOn: Schema.Array(SpecSectionId),
  files: Schema.Array(Schema.String),
  implements: Schema.Array(PrdSectionId),
});
export type SectionKeys = typeof SectionKeys.Type;

/** A heading of `prd.md` or `spec.md`, with its body, as `sectionsOf` reads it (see `spec.sections.parsing`). */
export const Section = Schema.Struct({
  /** The text up to the next heading of any level. */
  body: Schema.String,
  /** Its body or an ancestor's body has a `<!-- human -->` line. */
  human: Schema.Boolean,
  /** `undefined` when the heading has no `{#id}` yet. */
  id: Schema.UndefinedOr(SectionId),
  keys: SectionKeys,
  level: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 })),
  /** 1-based, for lint output. */
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The id of the nearest heading above it in the heading tree that has one. */
  parent: Schema.UndefinedOr(SectionId),
  /** The heading text without its `{#id}`. */
  title: Schema.String,
});
export type Section = typeof Section.Type;
