import type { SectionPrefix } from "@cairn/contract";
import { Array, HashMap, HashSet, Option, String, pipe } from "effect";

const FENCE = /^\s*(?:```|~~~)/u;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/u;
const TRAILING_ID = /[ \t]*\{#([^}\s]+)\}$/u;
const ITEM = /^ *(?:[-*+]|\d+[.)]) +(.*)$/u;
const DONE_WHEN = /^\s*Done when:\s*$/u;
/** The attribute that ends a list item's own text: `{#}` asks for an ID, `{#id}` is one. */
const ITEM_ATTRIBUTE = /[ \t]*\{#([^}\s]*)\}$/u;
const ITEM_ASK = /[ \t]*\{#\}(\s*)$/u;

export interface Heading {
  readonly id: Option.Option<string>;
  readonly level: number;
  readonly text: string;
}

interface Ancestor {
  readonly id: string;
  readonly level: number;
}

interface Assigned {
  readonly added: readonly string[];
  readonly ancestors: readonly Ancestor[];
  readonly taken: HashSet.HashSet<string>;
}

const headingOf = (line: string): Option.Option<Heading> =>
  pipe(
    line,
    String.match(HEADING),
    Option.map(([, hashes = "", rest = ""]) => ({
      id: pipe(rest, String.match(TRAILING_ID), Option.flatMap(Array.get(1))),
      level: hashes.length,
      text: pipe(rest, String.replace(TRAILING_ID, "")),
    })),
  );

const slugOf = (text: string): string =>
  pipe(
    text,
    String.toLowerCase,
    String.replaceAll(/[^a-z0-9]+/gu, "-"),
    String.replaceAll(/^-|-$/gu, ""),
    Option.liftPredicate(String.isNonEmpty),
    Option.getOrElse(() => "section"),
  );

/** `base`, or the first of `base-2`, `base-3`, ... that is not taken. */
const unusedId = (taken: HashSet.HashSet<string>, base: string, copy = 1): string => {
  const id = copy === 1 ? base : `${base}-${copy}`;
  return HashSet.has(taken, id) ? unusedId(taken, base, copy + 1) : id;
};

/** A level-1 heading titles the document, so it never namespaces a section. */
const namespaceOf = (ancestors: readonly Ancestor[], prefix: SectionPrefix): string =>
  pipe(
    Array.findLast(ancestors, (ancestor) => ancestor.level >= 2),
    Option.map((ancestor) => ancestor.id),
    Option.getOrElse(() => prefix),
  );

/** Per line: is it a fence marker or inside a fenced block? Nothing there is a heading or a marker. */
export const fencedOf = (lines: readonly string[]): readonly boolean[] =>
  Array.mapAccum(lines, false, (fenced, line) =>
    FENCE.test(line) ? [!fenced, true] : [fenced, fenced],
  )[1];

/** Per line: the heading on it, if it is one outside a fence. */
export const headingsOf = (lines: readonly string[]): readonly Option.Option<Heading>[] =>
  Array.zipWith(lines, fencedOf(lines), (line, fenced) =>
    fenced ? Option.none() : headingOf(line),
  );

/** What the item scanner needs to know about a line. */
interface Line {
  readonly blank: boolean;
  readonly doneWhen: boolean;
  readonly indent: number;
  /** The text after the list marker, when the line starts an item. */
  readonly item: Option.Option<string>;
  /** Not in a fence and not a heading, so it can belong to a list item. */
  readonly plain: boolean;
}

/** The `Done when:` list a statement belongs to. */
interface StatementList {
  /** The line index of the `Done when:` line. */
  readonly doneWhen: number;
  /** The indent of the `Done when:` line. */
  readonly doneWhenIndent: number;
  /** The indent of the list's own items; a deeper item is part of a statement. */
  readonly indent: number;
}

/** A list item outside a fence, as the scanner reads it. */
export interface ItemBlock {
  /** The trailing `{#...}`: `""` for `{#}`, which asks for an ID, else the ID as written. */
  readonly attribute: Option.Option<string>;
  /** The line index of the heading the item is under. */
  readonly heading: Option.Option<number>;
  readonly indent: number;
  /** The line index of the line with the list marker. */
  readonly index: number;
  /** The line index of the last line of the item's own text, where its attribute sits. */
  readonly last: number;
  /** The item's own text on one line, without its attribute. */
  readonly text: string;
}

/** A block, with the `Done when:` list it is in when it is a statement. */
interface Block extends ItemBlock {
  readonly list: Option.Option<StatementList>;
}

/** The item of a `Done when:` list that is a statement, with the line of the `Done when:` line above it. */
export interface StatementBlock extends ItemBlock {
  readonly doneWhen: number;
  readonly doneWhenIndent: number;
}

const lineOf = (line: string, fenced: boolean, heading: Option.Option<Heading>): Line => ({
  blank: String.isEmpty(String.trim(line)),
  doneWhen: DONE_WHEN.test(line),
  indent: String.length(line) - String.length(String.trimStart(line)),
  item: pipe(line, String.match(ITEM), Option.flatMap(Array.get(1))),
  plain: !fenced && Option.isNone(heading),
});

const nextNonBlank = (lines: readonly Line[], from: number): Option.Option<number> =>
  pipe(
    Array.drop(lines, from + 1),
    Array.findFirstIndex((line) => !line.blank),
    Option.map((offset) => from + 1 + offset),
  );

/**
 * The index of the last line of the run that starts at `start`. A line extends the run when it is
 * plain and `joins` it. A blank line extends it when the next line that is not blank does, and
 * `afterBlank` says so for a line that follows a blank one.
 */
const runEnd = (
  lines: readonly Line[],
  start: number,
  joins: (line: Line, afterBlank: boolean) => boolean,
): number =>
  start +
  Array.length(
    pipe(
      Array.drop(lines, start + 1),
      Array.takeWhile(
        (line, offset) =>
          line.plain &&
          (line.blank
            ? pipe(
                nextNonBlank(lines, start + 1 + offset),
                Option.flatMap((next) => Array.get(lines, next)),
                Option.exists((after) => after.plain && joins(after, true)),
              )
            : joins(line, false)),
      ),
    ),
  );

/**
 * Per line: the `Done when:` list it is in, if any. Those items are statements, not items. The
 * list is the one that follows a line reading exactly `Done when:`, with blank lines allowed
 * between. It runs while lines are its own items, are indented under one, or lazily continue one.
 */
const statementListsOf = (lines: readonly Line[]): readonly Option.Option<StatementList>[] => {
  const ranges = Array.getSomes(
    Array.map(lines, (line, index) =>
      line.doneWhen && line.plain
        ? pipe(
            nextNonBlank(lines, index),
            Option.flatMap((first) =>
              pipe(
                Array.get(lines, first),
                Option.filter((head) => head.plain && Option.isSome(head.item)),
                Option.map((head) => ({
                  doneWhen: index,
                  doneWhenIndent: line.indent,
                  from: first,
                  indent: head.indent,
                  to: runEnd(lines, first, (next, afterBlank) =>
                    Option.isSome(next.item)
                      ? next.indent >= head.indent
                      : !afterBlank || next.indent > head.indent,
                  ),
                })),
              ),
            ),
          )
        : Option.none(),
    ),
  );
  return Array.map(lines, (_, index) =>
    Array.findFirst(ranges, ({ from, to }) => index >= from && index <= to),
  );
};

/**
 * Every list item outside a fence, in document order, with its `Done when:` list when it is in
 * one. An item starts at a marker line. Its own text runs until a nested list or a later item, a
 * heading, a fence, a `Done when:` line, or a blank line followed by a line that is not indented
 * under it.
 */
const blocksOf = (lines: readonly string[]): readonly Block[] => {
  const headings = headingsOf(lines);
  const shapes = Array.map(
    Array.zip(lines, Array.zip(fencedOf(lines), headings)),
    ([line, [fenced, heading]]) => lineOf(line, fenced, heading),
  );
  const headingAbove = Array.mapAccum(headings, Option.none<number>(), (current, found, index) => {
    const next = Option.isSome(found) ? Option.some(index) : current;
    return [next, next];
  })[1];
  return Array.getSomes(
    Array.map(
      Array.zip(shapes, Array.zip(statementListsOf(shapes), headingAbove)),
      ([shape, [list, heading]], index) =>
        !shape.plain
          ? Option.none()
          : Option.map(shape.item, (first) => {
              const last = runEnd(
                shapes,
                index,
                (next, afterBlank) =>
                  Option.isNone(next.item) &&
                  !next.doneWhen &&
                  (!afterBlank || next.indent > shape.indent),
              );
              const written = pipe(
                lines,
                Array.drop(index + 1),
                Array.take(last - index),
                Array.map(String.trim),
                Array.filter(String.isNonEmpty),
                Array.prepend(String.trim(first)),
                Array.join(" "),
                String.trim,
              );
              return {
                attribute: pipe(
                  written,
                  String.match(ITEM_ATTRIBUTE),
                  Option.flatMap(Array.get(1)),
                ),
                heading,
                indent: shape.indent,
                index,
                last,
                list,
                text: pipe(written, String.replace(ITEM_ATTRIBUTE, "")),
              };
            }),
    ),
  );
};

/** Every list item outside a fence, in document order. The items of a `Done when:` list are statements and are left out. */
export const itemBlocksOf = (lines: readonly string[]): readonly ItemBlock[] =>
  Array.filter(blocksOf(lines), ({ list }) => Option.isNone(list));

/** The statements: the items at the top of each `Done when:` list, in document order. */
export const statementBlocksOf = (lines: readonly string[]): readonly StatementBlock[] =>
  Array.flatMapNullishOr(blocksOf(lines), (block) =>
    Option.match(block.list, {
      onNone: () => undefined,
      onSome: ({ doneWhen, doneWhenIndent, indent }) =>
        block.indent === indent ? { ...block, doneWhen, doneWhenIndent } : undefined,
    }),
  );

/** The IDs that items already carry. */
const itemIdsOf = (blocks: readonly ItemBlock[]): readonly string[] =>
  Array.getSomes(Array.map(blocks, (block) => Option.filter(block.attribute, String.isNonEmpty)));

const idsOf = (headings: readonly Option.Option<Heading>[]): string[] =>
  Array.getSomes(
    Array.map(
      headings,
      Option.flatMap((heading) => heading.id),
    ),
  );

export const linesOf = String.split("\n");

export const assignSectionIds = (
  markdown: string,
  prefix: SectionPrefix,
): { readonly added: readonly string[]; readonly markdown: string } => {
  const lines = linesOf(markdown);
  const headings = headingsOf(lines);
  const initial: Assigned = {
    added: [],
    ancestors: [],
    taken: HashSet.fromIterable(Array.appendAll(idsOf(headings), itemIdsOf(itemBlocksOf(lines)))),
  };

  const assign = (
    state: Assigned,
    line: string,
    found: Option.Option<Heading>,
  ): [Assigned, string] => {
    if (Option.isNone(found)) {
      return [state, line];
    }
    const { id: existing, level, text } = found.value;
    const ancestors = Array.filter(state.ancestors, (above) => above.level < level);
    if (Option.isSome(existing)) {
      const id = existing.value;
      return [{ ...state, ancestors: Array.append(ancestors, { id, level }) }, line];
    }
    const id = unusedId(state.taken, `${namespaceOf(ancestors, prefix)}.${slugOf(text)}`);
    const next: Assigned = {
      added: Array.append(state.added, id),
      ancestors: Array.append(ancestors, { id, level }),
      taken: HashSet.add(state.taken, id),
    };
    return [next, `${String.repeat(level)("#")} ${text} {#${id}}`];
  };

  const [{ added }, result] = Array.mapAccum(
    Array.zip(lines, headings),
    initial,
    (state, [line, found]) => assign(state, line, found),
  );
  return { added, markdown: Array.join(result, "\n") };
};

export const sectionIdsOf = (markdown: string): readonly string[] =>
  idsOf(headingsOf(linesOf(markdown)));

/** The first two words of an item's visible text, lowercased and joined by `-`. */
const itemSlugOf = (text: string): string =>
  pipe(
    text,
    String.replaceAll(/<!--.*?-->/gu, " "),
    String.replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, "$1"),
    String.toLowerCase,
    String.split(/\s+/u),
    Array.map(String.replaceAll(/[^a-z0-9]/gu, "")),
    Array.filter(String.isNonEmpty),
    Array.take(2),
    Array.join("-"),
    Option.liftPredicate(String.isNonEmpty),
    Option.getOrElse(() => "item"),
  );

/** What became of an item that asks for an ID: `id` is `none` when no heading with an ID is above it. */
interface AssignedItem {
  readonly first: number;
  readonly id: Option.Option<string>;
  readonly last: number;
}

/**
 * Fills each `{#}` that ends a list item with an ID: the ID of the heading the item sits under, `.`,
 * then the first two words of its text. On a clash it adds `-2`, `-3` and so on. `taken` holds IDs
 * in use outside the document; the document's own heading and item IDs are always taken. An item
 * with no heading with an ID above it keeps its `{#}`, and `unplaced` lists the 1-based lines of
 * those. Nothing else changes: an item with an ID or no attribute is left as written.
 */
export const assignItemIds = (
  markdown: string,
  taken: HashSet.HashSet<string> = HashSet.empty(),
): {
  readonly added: readonly string[];
  readonly markdown: string;
  readonly unplaced: readonly number[];
} => {
  const lines = linesOf(markdown);
  const headings = headingsOf(lines);
  const blocks = itemBlocksOf(lines);
  const initial = HashSet.union(
    taken,
    HashSet.fromIterable(Array.appendAll(idsOf(headings), itemIdsOf(blocks))),
  );

  const [, assigned] = Array.mapAccum(
    Array.filter(blocks, (block) => Option.exists(block.attribute, String.isEmpty)),
    initial,
    (used, block): [HashSet.HashSet<string>, AssignedItem] => {
      return pipe(
        block.heading,
        Option.flatMap((at) => Array.get(headings, at)),
        Option.flatten,
        Option.flatMap((heading) => heading.id),
        Option.match({
          onNone: () => [used, { first: block.index, id: Option.none(), last: block.last }],
          onSome: (headingId) => {
            const id = unusedId(used, `${headingId}.${itemSlugOf(block.text)}`);
            return [
              HashSet.add(used, id),
              { first: block.index, id: Option.some(id), last: block.last },
            ];
          },
        }),
      );
    },
  );

  const idByLine = HashMap.fromIterable(
    Array.getSomes(
      Array.map(assigned, ({ id, last }) => Option.map(id, (found) => [last, found] as const)),
    ),
  );
  return {
    added: Array.getSomes(Array.map(assigned, ({ id }) => id)),
    markdown: pipe(
      lines,
      Array.map((line, index) =>
        pipe(
          HashMap.get(idByLine, index),
          Option.match({
            onNone: () => line,
            onSome: (id) => pipe(line, String.replace(ITEM_ASK, ` {#${id}}$1`)),
          }),
        ),
      ),
      Array.join("\n"),
    ),
    unplaced: Array.flatMapNullishOr(assigned, ({ first, id }) =>
      Option.isNone(id) ? first + 1 : undefined,
    ),
  };
};
