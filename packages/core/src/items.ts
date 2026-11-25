import { SectionId } from "@cairn/contract";
import type { Section } from "@cairn/contract";
import { Array, Equal, Option, Schema, String } from "effect";

import { itemBlocksOf, linesOf } from "./section-ids.ts";
import { markerLinesOf } from "./sections.ts";

/** A list item of `prd.md` or `spec.md`, as `itemsOf` reads it (see `spec.sections.list-items`). */
export interface Item {
  /** The item ends in `{#}`: it asks `cairn ids` for an ID. */
  readonly asks: boolean;
  /** Its own text has a `<!-- human -->` marker, or its section or an item it is nested in does. */
  readonly human: boolean;
  /** `undefined` when the item has no `{#id}`, or the one it has is not a section ID. */
  readonly id: SectionId | undefined;
  /** 1-based, for lint output. */
  readonly line: number;
  /** The nearest item above it in the nesting that has an ID, or else the heading it is under. */
  readonly parent: SectionId | undefined;
  /** The heading it is under; `undefined` when that heading has no ID or there is none. */
  readonly section: SectionId | undefined;
  /** Its own text on one line, without the `{#...}` attribute. */
  readonly text: string;
}

/** An item above the one being read, kept for what its children inherit. */
interface Open {
  /** Its own ID, or the one it inherits from above: what a child names as its parent. */
  readonly anchor: Option.Option<SectionId>;
  readonly heading: Option.Option<number>;
  readonly human: boolean;
  readonly indent: number;
}

const decodeSectionId = Schema.decodeUnknownOption(SectionId);

/**
 * Every list item of `markdown` outside a fence, in document order. `sections` is
 * `sectionsOf(markdown)`. The items of a `Done when:` list are statements and are left out.
 */
export const itemsOf = (markdown: string, sections: readonly Section[]): readonly Item[] => {
  const markers = markerLinesOf(markdown);
  return Array.mapAccum(
    itemBlocksOf(linesOf(markdown)),
    Array.empty<Open>(),
    (stack, block): [readonly Open[], Item] => {
      const section = Option.flatMap(block.heading, (at) =>
        Array.findFirst(sections, ({ line }) => line === at + 1),
      );
      const sectionId = Option.flatMapNullishOr(section, ({ id }) => id);
      const above = Array.filter(
        stack,
        (open) => open.indent < block.indent && Equal.equals(open.heading, block.heading),
      );
      const parent = Array.last(above);
      const parentAnchor = Option.match(parent, {
        onNone: () => sectionId,
        onSome: (open) => open.anchor,
      });
      const id = Option.flatMap(block.attribute, decodeSectionId);
      const human =
        Array.some(markers, (line) => line > block.index && line <= block.last + 1) ||
        Option.exists(section, (heading) => heading.human) ||
        Option.exists(parent, (open) => open.human);
      const open: Open = {
        anchor: Option.orElse(id, () => parentAnchor),
        heading: block.heading,
        human,
        indent: block.indent,
      };
      return [
        Array.append(above, open),
        {
          asks: Option.exists(block.attribute, String.isEmpty),
          human,
          id: Option.getOrUndefined(id),
          line: block.index + 1,
          parent: Option.getOrUndefined(parentAnchor),
          section: Option.getOrUndefined(sectionId),
          text: block.text,
        },
      ];
    },
  )[1];
};
