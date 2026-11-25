import { PrdSectionId, SpecSectionId, StatementId } from "@cairn/contract";
import type { Section, SectionId } from "@cairn/contract";
import {
  Array,
  HashSet,
  Match,
  Option,
  Order,
  Predicate,
  Record,
  Result,
  Schema,
  String,
} from "effect";

import type { Item } from "./items.ts";

/** The part of the PRD that `cairn plan <id>...` plans (see `spec.planning.planning-a-part`). */
export interface Part {
  /** The named IDs plus every heading and list item under them. */
  readonly ids: HashSet.HashSet<PrdSectionId>;
  /** The IDs given, each once, in document order. */
  readonly named: ReadonlyArray<PrdSectionId>;
}

/** Why an ID given to `cairn plan` names no part of the PRD. */
export type UnknownPartReason = "no-such-id" | "spec-id" | "statement-id";

/** The IDs given to `cairn plan` that no PRD heading or list item has, in the order given. */
export interface UnknownPartIds {
  readonly unknown: ReadonlyArray<{ readonly id: string; readonly reason: UnknownPartReason }>;
}

/** A heading or list item, with the IDs of the headings and items it sits under. */
interface Placed {
  readonly above: ReadonlyArray<SectionId>;
  readonly id: SectionId | undefined;
  readonly line: number;
}

/** A heading is under the nearest heading above it of a lower level, and under what that one is under. */
const placedSectionsOf = (sections: ReadonlyArray<Section>): ReadonlyArray<Placed> =>
  Array.mapAccum(sections, Array.empty<Section>(), (stack, section) => {
    const above = Array.filter(stack, (open) => open.level < section.level);
    const placed: Placed = {
      above: Array.flatMapNullishOr(above, (open) => open.id),
      id: section.id,
      line: section.line,
    };
    return [Array.append(above, section), placed];
  })[1];

/**
 * An item is under the heading it follows and what that heading is under, and under each item
 * with an ID that it is nested in. `Item.parent` names that item, or the heading when there is
 * none; the heading is found by line, so an item under a heading with no ID still sits under the
 * headings above it.
 */
const placedItemsOf = (
  headings: ReadonlyArray<Placed>,
  items: ReadonlyArray<Item>,
): ReadonlyArray<Placed> =>
  Array.mapAccum(
    items,
    Record.empty<string, ReadonlyArray<SectionId>>(),
    (nesting, item): [Record.ReadonlyRecord<string, ReadonlyArray<SectionId>>, Placed] => {
      const heading = Option.match(
        Array.findLast(headings, ({ line }) => line < item.line),
        {
          onNone: (): ReadonlyArray<SectionId> => [],
          onSome: (found) =>
            Array.appendAll(found.above, Option.toArray(Option.fromUndefinedOr(found.id))),
        },
      );
      const nested = Option.match(
        Option.filter(Option.fromUndefinedOr(item.parent), (parent) => parent !== item.section),
        {
          onNone: (): ReadonlyArray<SectionId> => [],
          onSome: (parent) =>
            Array.append(
              Option.getOrElse(Record.get(nesting, parent), () => []),
              parent,
            ),
        },
      );
      return [
        Option.match(Option.fromUndefinedOr(item.id), {
          onNone: () => nesting,
          onSome: (id) => Record.set(nesting, id, nested),
        }),
        { above: Array.appendAll(heading, nested), id: item.id, line: item.line },
      ];
    },
  )[1];

/** A heading or list item with a PRD ID. */
interface Node {
  readonly above: ReadonlyArray<SectionId>;
  readonly id: PrdSectionId;
}

const isPrdSectionId = Schema.is(PrdSectionId);

/** Every heading and list item with a PRD ID, in document order. */
const nodesOf = (
  sections: ReadonlyArray<Section>,
  items: ReadonlyArray<Item>,
): ReadonlyArray<Node> => {
  const headings = placedSectionsOf(sections);
  return Array.filterMap(
    Array.sortWith(
      Array.appendAll(headings, placedItemsOf(headings, items)),
      (placed: Placed) => placed.line,
      Order.Number,
    ),
    ({ above, id }: Placed): Result.Result<Node, void> =>
      Predicate.isNotUndefined(id) && isPrdSectionId(id)
        ? Result.succeed({ above, id })
        : Result.failVoid,
  );
};

const reasonOf = (id: string): UnknownPartReason =>
  Match.value(id).pipe(
    Match.when(Schema.is(SpecSectionId), (): UnknownPartReason => "spec-id"),
    Match.when(Schema.is(StatementId), (): UnknownPartReason => "statement-id"),
    Match.orElse((): UnknownPartReason => "no-such-id"),
  );

/**
 * The part of the PRD that `ids` name (see `spec.planning.planning-a-part`): each named heading or
 * list item and everything under it, in the heading tree and the item nesting. A named item brings
 * the items nested in it, not the section around it. `sections` is `sectionsOf(prd)` and `items`
 * is `itemsOf(prd, sections)`, with missing IDs already assigned. Repeated IDs count once, and the
 * order they are given in does not matter. Fails with every ID that no heading or list item has.
 */
export const partOf = (
  sections: ReadonlyArray<Section>,
  items: ReadonlyArray<Item>,
  ids: ReadonlyArray<string>,
): Result.Result<Part, UnknownPartIds> => {
  const nodes = nodesOf(sections, items);
  const given = HashSet.fromIterable(ids);
  const unknown = Array.filterMap(Array.dedupe(ids), (id) =>
    Array.some(nodes, (node) => node.id === id)
      ? Result.failVoid
      : Result.succeed({ id, reason: reasonOf(id) }),
  );
  if (Array.isReadonlyArrayNonEmpty(unknown)) {
    return Result.fail({ unknown });
  }
  const named = Array.dedupe(
    Array.filterMap(nodes, ({ id }) =>
      HashSet.has(given, id) ? Result.succeed(id) : Result.failVoid,
    ),
  );
  const namedIds = HashSet.fromIterable<string>(named);
  return Result.succeed({
    ids: HashSet.fromIterable(
      Array.filterMap(nodes, ({ above, id }) =>
        HashSet.has(namedIds, id) || Array.some(above, (up) => HashSet.has(namedIds, up))
          ? Result.succeed(id)
          : Result.failVoid,
      ),
    ),
    named,
  });
};

/** The line `cairn plan` prints for an ID it refuses, one per ID. */
export const refusalOf = ({ id, reason }: UnknownPartIds["unknown"][number]): string =>
  Match.value(reason).pipe(
    Match.when(
      "no-such-id",
      () => `Unknown PRD ID ${id}: no heading or list item in .cairn/prd.md has it.`,
    ),
    Match.when(
      "spec-id",
      () => `${id} is a spec section. cairn plan <id> takes PRD headings and list items.`,
    ),
    Match.when(
      "statement-id",
      () =>
        `${id} is a done-when statement. Name its section, ${Array.headNonEmpty(String.split(id, "#"))}.`,
    ),
    Match.exhaustive,
  );
