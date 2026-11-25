import { PrdSectionId, StatementId, ownerOf } from "@cairn/contract";
import type { Section } from "@cairn/contract";
import { Array, Equal, HashMap, Number, Option, Schema, String, pipe } from "effect";

import { itemsOf } from "./items.ts";
import type { Item } from "./items.ts";
import { itemBlocksOf, linesOf, statementBlocksOf } from "./section-ids.ts";
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
  const highest = Array.reduce(
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
