import { SpecSectionId } from "@cairn/contract";
import type { Section } from "@cairn/contract";
import { Array, Predicate, Result, Schema } from "effect";

const isSpecSectionId = Schema.is(SpecSectionId);

/** A section of `spec.md` that has a spec section ID. */
export interface IdentifiedSection {
  readonly id: SpecSectionId;
  readonly section: Section;
}

/**
 * The sections with a spec section ID. It lives apart from `spec-index.ts`, which hashes bodies
 * with `node:crypto`, so the relation index and the stacks it lays out run in the browser.
 */
export const identifiedOf = (sections: ReadonlyArray<Section>): ReadonlyArray<IdentifiedSection> =>
  Array.filterMap(sections, (section) =>
    Predicate.isNotUndefined(section.id) && isSpecSectionId(section.id)
      ? Result.succeed({ id: section.id, section })
      : Result.failVoid,
  );
