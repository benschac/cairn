import type { Trace, TraceSection } from "@cairn/contract";
import {
  Array,
  Match,
  MutableRef,
  Number,
  Option,
  Order,
  Record,
  Result,
  Schema,
  String,
  pipe,
} from "effect";

import { documentOf, type ProseBlock } from "./markdown.ts";
import { Range } from "./range.ts";
import { Node, nodeKeyOf } from "./trace.ts";

export { Range, segmentsOf, type Segment } from "./range.ts";

/**
 * Which text of a node matched. Within one match class a title outranks an id, an id a branch,
 * and a branch prose.
 */
export const FieldKind = Schema.Literals(["title", "id", "branch", "prose"]);
export type FieldKind = typeof FieldKind.Type;

/** How a query matched a field, best first. */
export const MatchClass = Schema.Literals(["exact", "prefix", "contiguous", "typo", "subsequence"]);
export type MatchClass = typeof MatchClass.Type;

const fieldRank: Record.ReadonlyRecord<FieldKind, number> = {
  branch: 2,
  id: 1,
  prose: 3,
  title: 0,
};
const classRank: Record.ReadonlyRecord<MatchClass, number> = {
  contiguous: 2,
  exact: 0,
  prefix: 1,
  subsequence: 4,
  typo: 3,
};

/**
 * A piece of visible text a query can match. A field that is a block of a document, a title or a
 * paragraph, names it, so the document can mark the match in place.
 */
export const SearchField = Schema.Struct({
  block: Schema.optionalKey(Schema.String),
  kind: FieldKind,
  text: Schema.String,
});
export type SearchField = typeof SearchField.Type;

/** One node and the text searched for it. Its place in the content is its source order. */
export const SearchEntry = Schema.Struct({ fields: Schema.Array(SearchField), node: Node });
export type SearchEntry = typeof SearchEntry.Type;

/** What the index is built from. The index changes only when this does. */
export const SearchContent = Schema.Array(SearchEntry);
export type SearchContent = typeof SearchContent.Type;

const sameContent = Schema.toEquivalence(SearchContent);

/** The part of a long text around its first match, with the ranges that fall in it. */
export const Snippet = Schema.Struct({ ranges: Schema.Array(Range), text: Schema.String });
export type Snippet = typeof Snippet.Type;

/** One node's best match: the field it matched, how, and where in that field's text. */
export const SearchResult = Schema.Struct({
  field: FieldKind,
  matchClass: MatchClass,
  /** The block of the document the field is, when it is one: a section's title or a prose block. */
  maybeBlock: Schema.Option(Schema.String),
  node: Node,
  /** Sorted, non-overlapping, on code point boundaries of `text`. */
  ranges: Schema.Array(Range),
  /** Higher is better, comparable within one match class and field kind. */
  score: Schema.Finite,
  /** A bounded piece of the text around the match, for the result list. */
  snippet: Snippet,
  /** The whole text of the field, which `ranges` index: a title, an id, a branch or a paragraph. */
  text: Schema.String,
});
export type SearchResult = typeof SearchResult.Type;

/**
 * A window's search: the query, what it matched and the result the arrow keys stand on. The
 * results are derived once when the query or the trace changes; the active node is always one of
 * them, or none while there are none.
 */
export const Search = Schema.Struct({
  maybeActive: Schema.Option(Node),
  query: Schema.String,
  results: Schema.Array(SearchResult),
});
export type Search = typeof Search.Type;

/** No query, no results and nothing active. */
export const EMPTY_SEARCH: Search = { maybeActive: Option.none(), query: "", results: [] };

/** The id of the search input, which the results' pointer selection keeps focus in. */
export const SEARCH_INPUT_ID = "search-input";

/** The id of the result list the input controls. */
export const SEARCH_LISTBOX_ID = "search-results";

/** The id of a result's option, which the input names as its active descendant. */
export const searchOptionIdOf = (node: Node): string => `search-option-${nodeKeyOf(node)}`;

/** A lower-cased code point and the source range it came from. */
interface Char {
  readonly end: number;
  readonly start: number;
  readonly value: string;
}

interface IndexedField {
  readonly block: Option.Option<string>;
  readonly chars: ReadonlyArray<Char>;
  readonly kind: FieldKind;
  /** The lower-cased text, each character as `values` has it. */
  readonly lower: string;
  readonly text: string;
  readonly values: Values;
}

interface IndexedEntry {
  readonly fields: ReadonlyArray<IndexedField>;
  readonly key: string;
  readonly node: Node;
}

export interface SearchIndex {
  readonly content: SearchContent;
  readonly entries: ReadonlyArray<IndexedEntry>;
}

const WHITESPACE = /^\s$/u;

/**
 * Lower-cases text one code point at a time. A code point that lower-cases to several keeps the
 * source range of the original on each, so a range never splits a surrogate pair.
 */
const charsOf = (text: string): ReadonlyArray<Char> => {
  const [, sourced] = Array.mapAccum(Array.fromIterable(text), 0, (offset, codePoint) => [
    offset + String.length(codePoint),
    { end: offset + String.length(codePoint), start: offset, value: codePoint },
  ]);
  return Array.flatMap(sourced, ({ end, start, value }) =>
    Array.map(Array.fromIterable(String.toLowerCase(value)), (lower) => ({
      end,
      start,
      value: Match.value(lower).pipe(
        Match.when("ς", () => "σ"),
        Match.when(
          (character: string) => WHITESPACE.test(character),
          () => " ",
        ),
        Match.orElse(() => lower),
      ),
    })),
  );
};

const fieldOfBlock = (kind: FieldKind, block: ProseBlock): SearchField => ({
  block: block.key,
  kind,
  text: block.text,
});

/**
 * A section's searchable text: its title as the heading shows it, which differs from the title
 * in the trace when the heading has formatting, its id and the prose it owns.
 */
const sectionEntryOf =
  (markdown: string) =>
  (section: TraceSection): SearchEntry => {
    const document = documentOf(markdown);
    return {
      fields: Array.appendAll(
        [
          Option.match(Record.get(document.headings, section.id), {
            onNone: () => ({ kind: "title" as const, text: section.title }),
            onSome: (heading) => fieldOfBlock("title", heading),
          }),
          { kind: "id" as const, text: section.id },
        ],
        Array.map(
          Option.getOrElse(Record.get(document.proseOf, section.id), () => []),
          (block) => fieldOfBlock("prose", block),
        ),
      ),
      node: { id: section.id, kind: "section" as const },
    };
  };

/**
 * The searchable text of a trace: the titles, ids and prose of both documents' sections, and the
 * titles, ids and branches of tasks. The documents come from the parse the renderer shares.
 */
export const searchContentOf = (trace: Trace): SearchContent =>
  Array.appendAll(
    Array.appendAll(
      Array.map(trace.prd.sections, sectionEntryOf(trace.prd.markdown)),
      Array.map(trace.spec.sections, sectionEntryOf(trace.spec.markdown)),
    ),
    Array.map(trace.tasks, (task) => ({
      fields: [
        { kind: "title" as const, text: task.title },
        { kind: "id" as const, text: task.id },
        { kind: "branch" as const, text: task.branch },
      ],
      node: { id: task.id, kind: "task" as const },
    })),
  );

/** Normalises every field once, so a query only compares. */
export const buildIndex = (content: SearchContent): SearchIndex => ({
  content,
  entries: Array.map(content, (entry) => ({
    fields: Array.map(entry.fields, (field): IndexedField => {
      const chars = charsOf(field.text);
      const values = Array.map(chars, (char) => char.value);
      return {
        block: Option.fromNullishOr(field.block),
        chars,
        kind: field.kind,
        lower: Array.join(values, ""),
        text: field.text,
        values,
      };
    }),
    key: nodeKeyOf(entry.node),
    node: entry.node,
  })),
});

const cache = MutableRef.make<Option.Option<SearchIndex>>(Option.none());

/**
 * The index for a trace. It is kept until the searchable content changes, so a refresh that only
 * moves statuses, and every query, reuse it.
 */
export const indexOf = (trace: Trace): SearchIndex => {
  const content = searchContentOf(trace);
  return Option.getOrElse(
    Option.filter(MutableRef.get(cache), (index) => sameContent(index.content, content)),
    () => {
      const index = buildIndex(content);
      MutableRef.set(cache, Option.some(index));
      return index;
    },
  );
};

type Values = ReadonlyArray<string>;

/** A query token as its characters and as one string, so a field can be searched natively. */
interface Token {
  readonly text: string;
  readonly values: Values;
}

const tokenOf = (values: Values): Token => ({ text: Array.join(values, ""), values });

const sameValues = (left: Values, right: Values): boolean =>
  Array.length(left) === Array.length(right) &&
  Array.every(Array.zip(left, right), ([a, b]) => a === b);

/** A single insertion, deletion, substitution or adjacent transposition apart, or equal. */
const withinOneEdit = (token: Values, window: Values): boolean => {
  const tokenLength = Array.length(token);
  const windowLength = Array.length(window);
  const [shorter, longer] = tokenLength < windowLength ? [token, window] : [window, token];
  if (tokenLength === windowLength) {
    const differing = Array.getSomes(
      Array.map(Array.zip(token, window), ([a, b], index) =>
        a === b ? Option.none() : Option.some({ a, b, index }),
      ),
    );
    return Array.match(differing, {
      onEmpty: () => true,
      onNonEmpty: ([first, ...rest]) =>
        Array.match(rest, {
          onEmpty: () => true,
          onNonEmpty: ([second, ...others]) =>
            Array.isReadonlyArrayEmpty(others) &&
            second.index === first.index + 1 &&
            first.a === second.b &&
            first.b === second.a,
        }),
    });
  }
  return (
    Array.length(longer) === Array.length(shorter) + 1 &&
    // The first difference is where the extra character sits; everything after it must agree.
    sameValues(
      Array.drop(
        shorter,
        Option.getOrElse(
          Array.findFirstIndex(Array.zip(shorter, longer), ([a, b]) => a !== b),
          () => Array.length(shorter),
        ),
      ),
      Array.drop(
        longer,
        1 +
          Option.getOrElse(
            Array.findFirstIndex(Array.zip(shorter, longer), ([a, b]) => a !== b),
            () => Array.length(shorter),
          ),
      ),
    )
  );
};

interface Match {
  readonly indexes: ReadonlyArray<number>;
  readonly matchClass: MatchClass;
}

const run = (start: number, length: number): ReadonlyArray<number> =>
  Array.makeBy(length, (offset) => start + offset);

/** The index of the character that starts at a UTF-16 offset of the field's lower-cased text. */
const charIndexOf = (field: IndexedField, unitIndex: number): number =>
  String.length(field.lower) === Array.length(field.values)
    ? unitIndex
    : Array.length(Array.fromIterable(String.slice(0, unitIndex)(field.lower)));

/** Exact, prefix or contiguous: the matches that need no tolerance. */
const plainMatch = (field: IndexedField, token: Token): Option.Option<Match> => {
  const size = Array.length(token.values);
  return pipe(
    Option.liftPredicate(field.lower, (lower) => lower === token.text),
    Option.map(() => ({ indexes: run(0, size), matchClass: "exact" as const })),
    Option.orElse(() =>
      Option.map(Option.liftPredicate(field.lower, String.startsWith(token.text)), () => ({
        indexes: run(0, size),
        matchClass: "prefix" as const,
      })),
    ),
    Option.orElse(() =>
      Option.map(String.indexOf(token.text)(field.lower), (unitIndex) => ({
        indexes: run(charIndexOf(field, unitIndex), size),
        matchClass: "contiguous" as const,
      })),
    ),
  );
};

/** A token needs four characters before a typo is allowed. */
const TYPO_LENGTH = 4;

const matchesAt = (values: Values, at: number, expected: Values): boolean =>
  Array.every(expected, (value, offset) =>
    Option.exists(Array.get(values, at + offset), (found) => found === value),
  );

interface Window {
  readonly order: number;
  readonly size: number;
  readonly start: number;
}

/** Every UTF-16 offset a string occurs at in a text. */
const occurrencesOf = (text: string, needle: string): ReadonlyArray<number> =>
  Array.unfold(0, (from) =>
    Option.map(String.indexOf(needle)(String.slice(from)(text)), (found) => [
      from + found,
      from + found + 1,
    ]),
  );

/** Every index the characters `expected` occur at in the field, as native searches find them. */
const positionsOf = (field: IndexedField, expected: Values): ReadonlyArray<number> =>
  String.length(field.lower) === Array.length(field.values)
    ? occurrencesOf(field.lower, Array.join(expected, ""))
    : Array.filterMap(
        Array.makeBy(Array.length(field.values), (index) => index),
        (index) =>
          matchesAt(field.values, index, expected) ? Result.succeed(index) : Result.failVoid,
      );

/**
 * The first window of the field, in start order and then by size, within one edit of the token.
 * One edit leaves the window and the token sharing at least size - 2 characters across their
 * common prefix and suffix, so one of those is at least `shared` long. Only the windows that
 * start with the token's first `shared` characters, or end with its last, are compared.
 */
const typoMatch = (field: IndexedField, token: Token): Option.Option<Match> => {
  const size = Array.length(token.values);
  const shared = Math.floor((size - 1) / 2);
  const sizes = [size, size - 1, size + 1];
  const fits = (window: Window) =>
    window.start >= 0 && window.start + window.size <= Array.length(field.values);
  const windows = (
    positions: ReadonlyArray<number>,
    startOf: (position: number, size: number) => number,
  ) =>
    Array.flatMap(positions, (position) =>
      Array.map(sizes, (windowSize, order): Window => ({
        order,
        size: windowSize,
        start: startOf(position, windowSize),
      })),
    );
  return size < TYPO_LENGTH
    ? Option.none()
    : pipe(
        Array.appendAll(
          windows(positionsOf(field, Array.take(token.values, shared)), (position) => position),
          windows(
            positionsOf(field, Array.takeRight(token.values, shared)),
            (position, windowSize) => position + shared - windowSize,
          ),
        ),
        Array.filter(fits),
        Array.sortBy(
          Order.mapInput(Order.Number, (window: Window) => window.start),
          Order.mapInput(Order.Number, (window: Window) => window.order),
        ),
        Array.findFirst((window) =>
          withinOneEdit(
            token.values,
            Array.getSomes(
              Array.makeBy(window.size, (offset) => Array.get(field.values, window.start + offset)),
            ),
          ),
        ),
        Option.map((window) => ({
          indexes: run(window.start, window.size),
          matchClass: "typo" as const,
        })),
      );
};

/** Where in the field's text each character of the token is first found, in order, if all are. */
interface Reach {
  /** The UTF-16 offset after each character's greedy in-order match, when all are found. */
  readonly maybeInOrder: Option.Option<ReadonlyArray<number>>;
  /** Whether the token minus one character is found in order, which a typo needs. */
  readonly isNearlyInOrder: boolean;
}

/**
 * Whether leaving out one character of the token leaves the rest in order: the characters before
 * it end (`forward`) at or before the offset where the characters after it, found from the back,
 * start.
 */
const isOneAway = (
  field: IndexedField,
  token: Token,
  forward: ReadonlyArray<Option.Option<number>>,
): boolean => {
  const size = Array.length(token.values);
  const backward = Array.scan(
    Array.reverse(token.values),
    Option.some(String.length(field.lower)),
    (maybeLimit, value) =>
      Option.flatMap(maybeLimit, (limit) =>
        String.lastIndexOf(value)(String.slice(0, limit)(field.lower)),
      ),
  );
  return Array.some(
    Array.makeBy(size, (skipped) => skipped),
    (skipped) =>
      Option.exists(Option.flatten(Array.get(forward, skipped)), (end) =>
        Option.exists(
          Option.flatten(Array.get(backward, size - skipped - 1)),
          (start) => end <= start,
        ),
      ),
  );
};

/**
 * A necessary condition for any match, found with native string searches so most fields are
 * turned away without comparing their characters: the token is a subsequence of the field, or,
 * for a token that allows a typo, a subsequence once one character is left out. One edit changes
 * at most one character, so a typo match leaves the rest in order.
 */
const reachOf = (field: IndexedField, token: Token): Reach => {
  const forward = Array.scan(token.values, Option.some(0), (maybeAt, value) =>
    Option.flatMap(maybeAt, (from) =>
      Option.map(
        String.indexOf(value)(String.slice(from)(field.lower)),
        (found) => from + found + String.length(value),
      ),
    ),
  );
  const maybeInOrder = Option.all(Array.drop(forward, 1));
  return {
    isNearlyInOrder:
      Option.isSome(maybeInOrder) ||
      (Array.length(token.values) >= TYPO_LENGTH && isOneAway(field, token, forward)),
    maybeInOrder,
  };
};

/** The indexes of the first characters in order that make up the token, when there are some. */
const subsequenceIndexes = (
  field: IndexedField,
  token: Token,
): Option.Option<ReadonlyArray<number>> => {
  const { found, next } = Array.reduce(
    field.values,
    { found: Array.empty<number>(), next: 0 },
    (state, value, index) =>
      Option.match(Array.get(token.values, state.next), {
        onNone: () => state,
        onSome: (wanted) =>
          wanted === value
            ? { found: Array.append(state.found, index), next: state.next + 1 }
            : state,
      }),
  );
  return next === Array.length(token.values) ? Option.some(found) : Option.none();
};

/**
 * Every character in order, wherever the field has them; the loosest match. When each character
 * is one UTF-16 unit the greedy offsets `reach` found are the indexes; otherwise they are found
 * by character.
 */
const subsequenceOf = (field: IndexedField, token: Token, reach: Reach): Option.Option<Match> =>
  Option.map(
    Option.flatMap(reach.maybeInOrder, (ends) =>
      String.length(field.lower) === Array.length(field.values)
        ? Option.some(Array.map(ends, (end) => end - 1))
        : subsequenceIndexes(field, token),
    ),
    (indexes) => ({ indexes, matchClass: "subsequence" as const }),
  );

const matchToken = (field: IndexedField, token: Token, reach: Reach): Option.Option<Match> =>
  pipe(
    plainMatch(field, token),
    Option.orElse(() => typoMatch(field, token)),
    Option.orElse(() => subsequenceOf(field, token, reach)),
  );

interface FieldMatch {
  readonly indexes: ReadonlyArray<number>;
  readonly matchClass: MatchClass;
  readonly score: number;
}

/** Longer, earlier and tighter matches score higher. */
const scoreOf = (tokenLength: number, match: Match): number =>
  Option.match(Option.all([Array.head(match.indexes), Array.last(match.indexes)]), {
    onNone: () => 0,
    onSome: ([first, last]) => tokenLength * 100 - first * 2 - (last - first + 1 - tokenLength) * 5,
  });

const worseClass = (left: MatchClass, right: MatchClass): MatchClass =>
  classRank[left] >= classRank[right] ? left : right;

/**
 * Every token has to match this one field. A multi-word query that appears as a phrase counts as
 * a phrase, so an exact title beats a title that merely contains each word.
 */
const matchField = (
  field: IndexedField,
  tokens: ReadonlyArray<Token>,
  phrase: Token,
): Option.Option<FieldMatch> => {
  const fieldLength = Array.length(field.values);
  const asPhrase = Option.map(
    Option.filter(plainMatch(field, phrase), () => Array.length(tokens) > 1),
    (match): FieldMatch => ({
      ...match,
      score: scoreOf(Array.length(phrase.values), match) - fieldLength,
    }),
  );
  const perToken = () =>
    Option.map(
      Option.all(
        Array.map(tokens, (token) =>
          Option.map(matchToken(field, token, reachOf(field, token)), (match) => ({
            match,
            score: scoreOf(Array.length(token.values), match),
          })),
        ),
      ),
      (matches): FieldMatch => ({
        indexes: Array.flatMap(matches, ({ match }) => match.indexes),
        matchClass: Array.reduce(matches, "exact" as MatchClass, (worst, { match }) =>
          worseClass(worst, match.matchClass),
        ),
        score: Number.sumAll(Array.map(matches, ({ score }) => score)) - fieldLength,
      }),
    );
  return Array.every(tokens, (token) => reachOf(field, token).isNearlyInOrder)
    ? Option.orElse(asPhrase, perToken)
    : Option.none();
};

/** Sorted, merged source ranges of the matched characters. */
const rangesOf = (
  chars: ReadonlyArray<Char>,
  indexes: ReadonlyArray<number>,
): ReadonlyArray<Range> =>
  pipe(
    Array.sort(
      Array.getSomes(Array.map(Array.dedupe(indexes), (index) => Array.get(chars, index))),
      Order.mapInput(Order.Number, (char: Char) => char.start),
    ),
    Array.reduce(Array.empty<Range>(), (ranges, char) =>
      Option.match(Array.last(ranges), {
        onNone: () => [{ end: char.end, start: char.start }],
        onSome: (last) =>
          char.start <= last.end
            ? Array.append(Array.dropRight(ranges, 1), {
                end: Number.max(last.end, char.end),
                start: last.start,
              })
            : Array.append(ranges, { end: char.end, start: char.start }),
      }),
    ),
  );

/** Match class first, then title before id before branch before prose, then the higher score. */
const resultOrder: Order.Order<SearchResult> = Order.combineAll([
  Order.mapInput(Order.Number, (result: SearchResult) => classRank[result.matchClass]),
  Order.mapInput(Order.Number, (result: SearchResult) => fieldRank[result.field]),
  Order.flip(Order.mapInput(Order.Number, (result: SearchResult) => result.score)),
]);

interface Ranked {
  readonly key: string;
  readonly order: number;
  readonly result: SearchResult;
}

/** The result order, then source order, then node key: the same input always sorts the same. */
const rankedOrder: Order.Order<Ranked> = Order.combineAll([
  Order.mapInput(resultOrder, (ranked: Ranked) => ranked.result),
  Order.mapInput(Order.Number, (ranked: Ranked) => ranked.order),
  Order.mapInput(Order.String, (ranked: Ranked) => ranked.key),
]);

/** Characters a snippet shows, at most, and how many of them come before the first match. */
const SNIPPET_LENGTH = 120;
const SNIPPET_LEAD = 40;
const ELLIPSIS = "…";

/** Whether the code unit at an index is the second half of a surrogate pair. */
const isLowSurrogateAt = (text: string, index: number): boolean =>
  Option.exists(String.charCodeAt(text, index), (unit) => unit >= 0xdc00 && unit <= 0xdfff);

/**
 * A text of at most `SNIPPET_LENGTH` characters as it is, and a longer one cut to that length
 * around its first match, with an ellipsis where it was cut. The cut never splits a surrogate
 * pair, and the ranges are the matched ones that fall in the piece, shifted onto it.
 */
export const snippetOf = (text: string, ranges: ReadonlyArray<Range>): Snippet => {
  const length = String.length(text);
  if (length <= SNIPPET_LENGTH) {
    return { ranges, text };
  }
  const first = Option.getOrElse(
    Option.map(Array.head(ranges), (range) => range.start),
    () => 0,
  );
  const wanted = Number.clamp(first - SNIPPET_LEAD, {
    maximum: length - SNIPPET_LENGTH,
    minimum: 0,
  });
  const from = isLowSurrogateAt(text, wanted) ? wanted + 1 : wanted;
  const wantedEnd = wanted + SNIPPET_LENGTH;
  const to = isLowSurrogateAt(text, wantedEnd) ? wantedEnd - 1 : wantedEnd;
  const lead = from > 0 ? ELLIPSIS : "";
  const shift = String.length(lead) - from;
  return {
    ranges: Array.filterMap(ranges, (range) =>
      range.end > from && range.start < to
        ? Result.succeed({
            end: Number.min(range.end, to) + shift,
            start: Number.max(range.start, from) + shift,
          })
        : Result.failVoid,
    ),
    text: `${lead}${pipe(text, String.slice(from, to))}${to < length ? ELLIPSIS : ""}`,
  };
};

/** The query's whitespace-separated tokens, lower-cased. */
const tokensOf = (query: string): ReadonlyArray<Token> =>
  Array.map(Array.filter(String.split(String.trim(query), /\s+/), String.isNonEmpty), (token) =>
    tokenOf(Array.map(charsOf(token), (char) => char.value)),
  );

/** The node's best match for the tokens, over all its fields. */
const bestOf = (
  entry: IndexedEntry,
  order: number,
  tokens: ReadonlyArray<Token>,
  phrase: Token,
): Option.Option<Ranked> =>
  Option.map(
    Array.head(
      Array.sort(
        Array.getSomes(
          Array.map(entry.fields, (field) =>
            Option.map(matchField(field, tokens, phrase), (match): SearchResult => {
              const ranges = rangesOf(field.chars, match.indexes);
              return {
                field: field.kind,
                matchClass: match.matchClass,
                maybeBlock: field.block,
                node: entry.node,
                ranges,
                score: match.score,
                snippet: snippetOf(field.text, ranges),
                text: field.text,
              };
            }),
          ),
        ),
        resultOrder,
      ),
    ),
    (result): Ranked => ({ key: entry.key, order, result }),
  );

/**
 * The nodes a query matches, best first, one result each with the field that matched best. An
 * empty or blank query matches nothing.
 */
export const search = (index: SearchIndex, query: string): ReadonlyArray<SearchResult> => {
  const tokens = tokensOf(query);
  const phrase = tokenOf(
    Array.flatten(
      Array.intersperse(
        Array.map(tokens, (token) => token.values),
        [" "],
      ),
    ),
  );
  return Array.match(tokens, {
    onEmpty: () => [],
    onNonEmpty: () =>
      Array.map(
        Array.sortWith(
          Array.getSomes(
            Array.map(index.entries, (entry, order) => bestOf(entry, order, tokens, phrase)),
          ),
          (ranked) => ranked,
          rankedOrder,
        ),
        (ranked) => ranked.result,
      ),
  });
};

/** The results for a query over a trace, building the index only if the content changed. */
export const searchTrace = (trace: Trace, query: string): ReadonlyArray<SearchResult> =>
  search(indexOf(trace), query);

const sameNode = (left: Node, right: Node): boolean => nodeKeyOf(left) === nodeKeyOf(right);

/** The node's result, when the query matched it. */
export const resultOf = (
  results: ReadonlyArray<SearchResult>,
  node: Node,
): Option.Option<SearchResult> => Array.findFirst(results, (result) => sameNode(result.node, node));

/** The best result's node: where a new query starts, and none when nothing matched. */
export const firstActive = (results: ReadonlyArray<SearchResult>): Option.Option<Node> =>
  Option.map(Array.head(results), (result) => result.node);

/** The active node once the results change: kept while it still matches, else the first. */
export const reconcileActive = (
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
): Option.Option<Node> =>
  Option.orElse(
    Option.filter(maybeActive, (active) => Option.isSome(resultOf(results, active))),
    () => firstActive(results),
  );

/**
 * The result an arrow key moves to, one step down the list or up it. The list ends stop the
 * walk, and with nothing active the first result is where it starts.
 */
export const stepActive = (
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  step: 1 | -1,
): Option.Option<Node> =>
  Option.orElse(
    Option.flatMap(
      Option.flatMap(maybeActive, (active) =>
        Array.findFirstIndex(results, (result) => sameNode(result.node, active)),
      ),
      (at) =>
        Option.map(
          Array.get(
            results,
            Number.clamp(at + step, { maximum: Array.length(results) - 1, minimum: 0 }),
          ),
          (result) => result.node,
        ),
    ),
    () => firstActive(results),
  );
