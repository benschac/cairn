import { PrdSectionId, StatementId, ownerOf } from "@cairn/contract";
import type { Section } from "@cairn/contract";
import { Array, Equal, HashMap, Number, Option, Order, Schema, String, pipe } from "effect";

import { itemsOf } from "./items.ts";
import type { Item } from "./items.ts";
import { headingsOf, itemBlocksOf, linesOf, statementBlocksOf } from "./section-ids.ts";
import type { ItemBlock } from "./section-ids.ts";
import { markerLinesOf, sectionsOf } from "./sections.ts";

/** A done-when statement of `prd.md`, as `statementsOf` reads it (see `spec.planning.done-when.statements`). */
export interface Statement {
  /** A statement that begins `Draft: `: Cairn wrote it and no person has confirmed it. */
  readonly draft: boolean;
  /** Its own text has a `<!-- human -->` marker. */
  readonly human: boolean;
  /** `undefined` when the statement has no `{#id}`, or the one it has is not a statement ID. */
  readonly id: StatementId | undefined;
  /** 1-based, for lint output. */
  readonly line: number;
  /** The item its `Done when:` line is nested under, or else the heading it is in. */
  readonly owner: PrdSectionId;
  /** Its own text on one line, without the `{#...}` attribute, `Draft: ` and marker included. */
  readonly text: string;
}

const decodeStatementId = Schema.decodeUnknownOption(StatementId);
const decodePrdSectionId = Schema.decodeUnknownOption(PrdSectionId);

const DRAFT = "Draft: ";
/** `{#}` at the end of a line: a request for an ID, which the ID replaces. */
const ASK = /[ \t]*\{#\}\s*$/u;

/**
 * Every statement of `markdown` outside a fence, in document order. `sections` is
 * `sectionsOf(markdown)` and `items` is `itemsOf(markdown, sections)`. A statement list is the
 * list after a line reading exactly `Done when:`; the items nested in one of its statements belong
 * to that statement's text. A statement whose owner has no ID is left out, since no ID can be built
 * for it.
 */
export const statementsOf = (
  markdown: string,
  sections: readonly Section[],
  items: readonly Item[],
): readonly Statement[] => {
  const lines = linesOf(markdown);
  const blocks = statementBlocksOf(lines);
  // Reading the markers parses the document, which a document with no statement list can skip.
  const markers = Array.isReadonlyArrayEmpty(blocks) ? [] : markerLinesOf(markdown);
  const itemBlocks = itemBlocksOf(lines);
  return Array.getSomes(
    Array.map(blocks, (block) => {
      const heading = pipe(
        block.heading,
        Option.flatMap((at) => Array.findFirst(sections, ({ line }) => line === at + 1)),
        Option.flatMapNullishOr(({ id }) => id),
      );
      const owner = pipe(
        Array.findLast(
          itemBlocks,
          (above) =>
            above.index < block.doneWhen &&
            above.indent < block.doneWhenIndent &&
            Equal.equals(above.heading, block.heading),
        ),
        Option.flatMap((above) => Array.findFirst(items, ({ line }) => line === above.index + 1)),
        Option.flatMap((item) =>
          Option.orElse(Option.fromUndefinedOr(item.id), () => Option.fromUndefinedOr(item.parent)),
        ),
        Option.orElse(() => heading),
        Option.flatMap(decodePrdSectionId),
      );
      return Option.map(owner, (found) => ({
        draft: String.startsWith(DRAFT)(block.text),
        human: Array.some(markers, (line) => line > block.index && line <= block.last + 1),
        id: Option.getOrUndefined(Option.flatMap(block.attribute, decodeStatementId)),
        line: block.index + 1,
        owner: found,
        text: block.text,
      }));
    }),
  );
};

/** The number in `<owner>#v<n>`. */
const versionOf = (id: StatementId): number =>
  pipe(
    String.split(id, "#v"),
    Array.last,
    Option.flatMap(Number.parse),
    Option.getOrElse(() => 0),
  );

/** The highest number the IDs of `statements` show, for each owner. */
const highestOf = (statements: readonly Statement[]): HashMap.HashMap<string, number> =>
  Array.reduce(
    Array.getSomes(Array.map(statements, ({ id }) => Option.fromUndefinedOr(id))),
    HashMap.empty<string, number>(),
    (used, id) =>
      HashMap.modifyAt(used, ownerOf(id), (seen) =>
        Option.some(
          Number.max(
            Option.getOrElse(seen, () => 0),
            versionOf(id),
          ),
        ),
      ),
  );

/**
 * Gives each statement of `statements` that has no ID `{#<owner>#v<n>}`, where `n` is one more
 * than the highest number the statements' IDs show for that owner. An ID already there is never
 * changed, and no number is reused. `statements` is `statementsOf` of `markdown`. A `{#}` is
 * replaced; otherwise the ID goes at the end of the statement's last line.
 */
export const assignStatementIds = (
  markdown: string,
  statements: readonly Statement[],
): { readonly added: readonly StatementId[]; readonly markdown: string } => {
  const lines = linesOf(markdown);
  const lastLineOf = HashMap.fromIterable(
    Array.map(statementBlocksOf(lines), (block) => [block.index + 1, block.last] as const),
  );
  const highest = highestOf(statements);
  const [, assigned] = Array.mapAccum(
    Array.filter(statements, ({ id }) => id === undefined),
    highest,
    (
      used,
      { line, owner },
    ): [HashMap.HashMap<string, number>, Option.Option<readonly [number, StatementId]>] => {
      const next = Option.getOrElse(HashMap.get(used, owner), () => 0) + 1;
      return [
        HashMap.set(used, owner, next),
        pipe(
          HashMap.get(lastLineOf, line),
          Option.flatMap((last) =>
            Option.map(decodeStatementId(`${owner}#v${next}`), (id) => [last, id] as const),
          ),
        ),
      ];
    },
  );
  const idByLine = HashMap.fromIterable(Array.getSomes(assigned));
  return {
    added: Array.map(Array.getSomes(assigned), ([, id]) => id),
    markdown: pipe(
      lines,
      Array.map((line, index) =>
        pipe(
          HashMap.get(idByLine, index),
          Option.match({
            onNone: () => line,
            onSome: (id) => `${pipe(line, String.replace(ASK, ""), String.trimEnd)} {#${id}}`,
          }),
        ),
      ),
      Array.join("\n"),
    ),
  };
};

/**
 * `assignStatementIds` for a whole document: reads its sections, items and statements, then
 * numbers the statements. A document with no statement list is returned as it is, without parsing.
 */
export const numberStatements = (
  markdown: string,
): { readonly added: readonly StatementId[]; readonly markdown: string } => {
  if (Array.isReadonlyArrayEmpty(statementBlocksOf(linesOf(markdown)))) {
    return { added: [], markdown };
  }
  const sections = sectionsOf(markdown);
  return assignStatementIds(
    markdown,
    statementsOf(markdown, sections, itemsOf(markdown, sections)),
  );
};

/** What `Planner.statements` returns for one target: drafts to put under it (see `withDrafts`). */
export interface Drafted {
  /** An empty list: the target describes nothing to build. */
  readonly drafts: readonly string[];
  /** The section, or the list item with an ID, the drafts are for. */
  readonly target: PrdSectionId;
}

/** A draft's own words on one line: no `Draft:`, no `{#...}`, no line breaks. */
const wordsOf = (text: string): string =>
  pipe(
    text,
    String.replaceAll(/\s+/gu, " "),
    String.trim,
    String.replace(/^Draft:\s*/iu, ""),
    String.replace(/\s*\{#[^}]*\}$/u, ""),
    String.trim,
  );

/** The list marker that starts an item's first line, with the indent before it and the space after. */
const MARKER = /^ *(?:[-*+]|\d+[.)]) +/u;
const DRAFT_MARKER = /^( *(?:[-*+]|\d+[.)]) +)Draft: /u;

const isBlank = (line: string): boolean => String.isEmpty(String.trim(line));
const indentOf = (line: string): number =>
  String.length(line) - String.length(String.trimStart(line));
const markerOf = (line: string): string =>
  pipe(
    line,
    String.match(MARKER),
    Option.flatMap(Array.get(0)),
    Option.getOrElse(() => ""),
  );

/**
 * The index of the last line of the item `block`: its own text and what is nested under it, but
 * not the blank lines after.
 */
const extentOf = (lines: readonly string[], block: ItemBlock): number =>
  block.last +
  Array.length(
    pipe(
      lines,
      Array.drop(block.last + 1),
      Array.takeWhile((line) => isBlank(line) || indentOf(line) > block.indent),
      Array.reverse,
      Array.dropWhile(isBlank),
    ),
  );

/** Where a `Done when:` list goes: after the line `after`, with `indent` spaces before each line. */
interface Place {
  readonly after: number;
  readonly indent: number;
  /** Lists that land after one line go in order of rank, so a list nested deeper comes first. */
  readonly rank: number;
}

/** The end of a section's own body: its last line that is not blank, before the next heading. */
const sectionPlaceOf = (
  lines: readonly string[],
  headings: readonly Option.Option<unknown>[],
  section: Section,
): Place => {
  const at = section.line - 1;
  const own = pipe(
    lines,
    Array.drop(at + 1),
    Array.take(
      pipe(
        headings,
        Array.drop(at + 1),
        Array.findFirstIndex(Option.isSome),
        Option.getOrElse(() => Array.length(lines)),
      ),
    ),
  );
  return {
    after: pipe(
      Array.findLastIndex(own, (line) => !isBlank(line)),
      Option.match({ onNone: () => at, onSome: (found) => at + 1 + found }),
    ),
    indent: 0,
    rank: 0,
  };
};

/** The end of an item, with the indent of its own text. */
const itemPlaceOf = (lines: readonly string[], block: ItemBlock): Place => {
  const indent = pipe(
    Array.get(lines, block.index),
    Option.map((line) => String.length(markerOf(line))),
    Option.getOrElse(() => block.indent + 2),
  );
  return { after: extentOf(lines, block), indent, rank: -indent };
};

/** A line of the result of `withDrafts`, and whether it is new. */
interface Row {
  readonly inserted: boolean;
  readonly text: string;
}

/** A target's new `Done when:` list: its lines, and the IDs of the statements in them. */
interface Listed {
  readonly ids: readonly StatementId[];
  readonly place: Place;
  readonly statements: readonly string[];
}

/**
 * Puts drafts into `markdown` as `- Draft: <text> {#<owner>#v<n>}`, each target's under a new
 * `Done when:` line: at the end of a section's own body, before its first child heading, or
 * indented under a list item after its nested items. `n` is one more than the highest number the
 * owner's statements already use. It changes no existing line: `inserted` lists the 0-based lines of
 * the result that are new, and without them the result is `markdown` byte for byte. A target that
 * is no section or item with an ID, and a draft with no words, are left out.
 */
export const withDrafts = (
  markdown: string,
  drafted: readonly Drafted[],
): {
  readonly added: readonly StatementId[];
  readonly inserted: readonly number[];
  readonly markdown: string;
} => {
  const lines = linesOf(markdown);
  const sections = sectionsOf(markdown);
  const items = itemsOf(markdown, sections);
  const headings = headingsOf(lines);
  const blocks = Array.zip(itemBlocksOf(lines), items);
  const [, placed] = Array.mapAccum(
    Array.filter(
      Array.map(drafted, ({ drafts, target }) => ({
        target,
        words: Array.filter(Array.map(drafts, wordsOf), String.isNonEmpty),
      })),
      ({ words }) => Array.isReadonlyArrayNonEmpty(words),
    ),
    highestOf(statementsOf(markdown, sections, items)),
    (used, { target, words }): [HashMap.HashMap<string, number>, Option.Option<Listed>] => {
      const first = Option.getOrElse(HashMap.get(used, target), () => 0) + 1;
      const numbered = Array.getSomes(
        Array.map(words, (text, offset) =>
          Option.map(decodeStatementId(`${target}#v${first + offset}`), (id) => ({ id, text })),
        ),
      );
      const place = pipe(
        Array.findFirst(blocks, ([, item]) => Equal.equals(item.id, target)),
        Option.map(([block]) => itemPlaceOf(lines, block)),
        Option.orElse(() =>
          pipe(
            Array.findFirst(sections, (section) => Equal.equals(section.id, target)),
            Option.map((section) => sectionPlaceOf(lines, headings, section)),
          ),
        ),
      );
      return [
        HashMap.set(used, target, first + Array.length(words) - 1),
        Option.map(place, (found) => {
          const pad = String.repeat(found.indent)(" ");
          return {
            ids: Array.map(numbered, ({ id }) => id),
            place: found,
            statements: Array.appendAll(
              [``, `${pad}Done when:`, ``],
              Array.map(numbered, ({ id, text }) => `${pad}- ${DRAFT}${text} {#${id}}`),
            ),
          };
        }),
      ];
    },
  );
  const lists = Array.sort(
    Array.getSomes(placed),
    Order.mapInput(Order.Number, ({ place }: Listed) => place.rank),
  );
  const result = Array.flatMap(lines, (line, index): readonly Row[] =>
    Array.prepend(
      Array.flatMap(
        Array.filter(lists, ({ place }: Listed) => place.after === index),
        ({ statements }: Listed) =>
          Array.map(statements, (text): Row => ({ inserted: true, text })),
      ),
      { inserted: false, text: line },
    ),
  );
  return {
    added: Array.flatMap(Array.getSomes(placed), ({ ids }) => ids),
    inserted: Array.getSomes(
      Array.map(result, ({ inserted }, index) => (inserted ? Option.some(index) : Option.none())),
    ),
    markdown: Array.join(
      Array.map(result, ({ text }) => text),
      "\n",
    ),
  };
};

/** What a person answers about a draft: keep it as written, put their own words in its place, drop it, or leave it for later. */
export const DraftAnswer = Schema.Union([
  Schema.TaggedStruct("accept", {}),
  Schema.TaggedStruct("rewrite", { text: Schema.String }),
  Schema.TaggedStruct("delete", {}),
  Schema.TaggedStruct("skip", {}),
]).pipe(Schema.toTaggedUnion("_tag"));
export type DraftAnswer = typeof DraftAnswer.Type;

/** The lines of `lines` but those from `from` to `to`. */
const withoutRange = (lines: readonly string[]) => (from: number, to: number) =>
  Array.filter(lines, (_, index) => index < from || index > to);

/**
 * Settles the statement `id` of `markdown` with `answer`. `accept` removes `Draft: `, and does
 * nothing to a statement that is confirmed already. `rewrite` replaces the statement's text with
 * the person's words, confirmed, under the same ID; words that are empty change nothing. `delete`
 * removes the statement, and the `Done when:` line, its list and the blank line above it when the
 * list is left empty. `skip` changes nothing, and so does an ID no statement has.
 */
export const settle = (markdown: string, id: StatementId, answer: DraftAnswer): string => {
  const lines = linesOf(markdown);
  const blocks = statementBlocksOf(lines);
  return pipe(
    Array.findFirst(blocks, ({ attribute }) => Option.exists(attribute, (found) => found === id)),
    Option.match({
      onNone: () => markdown,
      onSome: (block) => {
        const without = withoutRange(lines);
        const rewritten = DraftAnswer.match(answer, {
          accept: () =>
            Array.map(lines, (line, index) =>
              index === block.index ? pipe(line, String.replace(DRAFT_MARKER, "$1")) : line,
            ),
          delete: () =>
            Array.some(blocks, (other) => other.doneWhen === block.doneWhen && other !== block)
              ? without(block.index, extentOf(lines, block))
              : without(
                  Array.get(lines, block.doneWhen - 1).pipe(Option.exists(isBlank))
                    ? block.doneWhen - 1
                    : block.doneWhen,
                  extentOf(lines, block),
                ),
          rewrite: ({ text }) => {
            const words = wordsOf(text);
            return String.isEmpty(words)
              ? lines
              : Array.flatMap(lines, (line, index) =>
                  index === block.index
                    ? [`${markerOf(line)}${words} {#${id}}`]
                    : index > block.index && index <= block.last
                      ? []
                      : [line],
                );
          },
          skip: () => lines,
        });
        return Array.join(rewritten, "\n");
      },
    }),
  );
};
