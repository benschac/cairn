import type { Trace } from "@cairn/contract";
import { Array, MutableRef, Number, Option, Order, Record, Schema, String, pipe } from "effect";

import { Node, nodeKeyOf } from "./trace.ts";

/**
 * Which text of a node matched. Within one match class a title outranks an id, an id a branch,
 * and a branch prose. Nothing indexes prose yet; the prose search adds fields of that kind.
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

/** A piece of visible text a query can match. */
export const SearchField = Schema.Struct({ kind: FieldKind, text: Schema.String });
export type SearchField = typeof SearchField.Type;

/** One node and the text searched for it. Its place in the content is its source order. */
export const SearchEntry = Schema.Struct({ fields: Schema.Array(SearchField), node: Node });
export type SearchEntry = typeof SearchEntry.Type;

/** What the index is built from. The index changes only when this does. */
export const SearchContent = Schema.Array(SearchEntry);
export type SearchContent = typeof SearchContent.Type;

const sameContent = Schema.toEquivalence(SearchContent);

/** A half-open range of UTF-16 code units in a field's text. */
export interface Range {
  readonly end: number;
  readonly start: number;
}

/** One node's best match: the field it matched, how, and where in that field's text. */
export interface SearchResult {
  readonly field: FieldKind;
  readonly matchClass: MatchClass;
  readonly node: Node;
  /** Sorted, non-overlapping, on code point boundaries of `text`. */
  readonly ranges: ReadonlyArray<Range>;
  /** Higher is better, comparable within one match class and field kind. */
  readonly score: number;
  readonly text: string;
}

/** A lower-cased code point and the source range it came from. */
interface Char {
  readonly end: number;
  readonly start: number;
  readonly value: string;
}

interface IndexedField {
  readonly chars: ReadonlyArray<Char>;
  readonly kind: FieldKind;
  readonly text: string;
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
      value: lower === "ς" ? "σ" : lower,
    })),
  );
};

/** The searchable text of a trace: titles and ids of both documents' sections, and tasks. */
export const searchContentOf = (trace: Trace): SearchContent =>
  Array.appendAll(
    Array.map(Array.appendAll(trace.prd.sections, trace.spec.sections), (section) => ({
      fields: [
        { kind: "title" as const, text: section.title },
        { kind: "id" as const, text: section.id },
      ],
      node: { id: section.id, kind: "section" as const },
    })),
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
    fields: Array.map(entry.fields, (field) => ({ ...field, chars: charsOf(field.text) })),
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

const valuesOf = (chars: ReadonlyArray<Char>): Values => Array.map(chars, (char) => char.value);

const sameValues = (left: Values, right: Values): boolean =>
  Array.length(left) === Array.length(right) &&
  Array.every(Array.zip(left, right), ([a, b]) => a === b);

/**
 * One edit cannot change both ends of a token of four or more characters, so a window that
 * shares neither end is no typo. It spares the costlier comparison for most windows.
 */
const sharesAnEnd = (token: Values, window: Values): boolean =>
  Option.exists(Array.head(token), (first) =>
    Option.exists(Array.head(window), (other) => other === first),
  ) ||
  Option.exists(Array.last(token), (last) =>
    Option.exists(Array.last(window), (other) => other === last),
  );

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

/** Where in the field's values a token or phrase sits as a run, from the first start. */
const runOf = (
  field: Values,
  token: Values,
  matchClass: MatchClass,
  windowSizes: ReadonlyArray<number>,
  accepts: (window: Values) => boolean,
): Option.Option<Match> =>
  Array.findFirst(
    Array.filter(
      Array.flatMap(
        Array.makeBy(Array.length(field) + 1, (start) => start),
        (start) => Array.map(windowSizes, (size) => ({ size, start })),
      ),
      ({ size, start }) => start + size <= Array.length(field),
    ),
    ({ size, start }) => accepts(Array.take(Array.drop(field, start), size)),
  ).pipe(Option.map(({ size, start }) => ({ indexes: run(start, size), matchClass })));

const subsequenceOf = (field: Values, token: Values): Option.Option<Match> => {
  const { found, next } = Array.reduce(
    field,
    { found: Array.empty<number>(), next: 0 },
    (state, value, index) =>
      Option.match(Array.get(token, state.next), {
        onNone: () => state,
        onSome: (wanted) =>
          wanted === value
            ? { found: Array.append(state.found, index), next: state.next + 1 }
            : state,
      }),
  );
  return next === Array.length(token)
    ? Option.some({ indexes: found, matchClass: "subsequence" })
    : Option.none();
};

/** Exact, prefix or contiguous: the matches that need no tolerance. */
const plainMatch = (field: Values, token: Values): Option.Option<Match> => {
  const size = Array.length(token);
  const at = (accepts: (window: Values) => boolean) =>
    runOf(field, token, "contiguous", [size], accepts);
  return pipe(
    Option.map(
      Option.liftPredicate(field, (values) => sameValues(values, token)),
      () => ({ indexes: run(0, size), matchClass: "exact" as const }),
    ),
    Option.orElse(() =>
      Option.map(
        Option.liftPredicate(Array.take(field, size), (head) => sameValues(head, token)),
        () => ({ indexes: run(0, size), matchClass: "prefix" as const }),
      ),
    ),
    Option.orElse(() => at((window) => sameValues(window, token))),
  );
};

/** A token needs four characters before a typo is allowed. */
const TYPO_LENGTH = 4;

const matchToken = (field: Values, token: Values): Option.Option<Match> => {
  const size = Array.length(token);
  return pipe(
    plainMatch(field, token),
    Option.orElse(() =>
      size >= TYPO_LENGTH
        ? runOf(
            field,
            token,
            "typo",
            [size, size - 1, size + 1],
            (window) => sharesAnEnd(token, window) && withinOneEdit(token, window),
          )
        : Option.none(),
    ),
    Option.orElse(() => subsequenceOf(field, token)),
  );
};

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
  tokens: ReadonlyArray<Values>,
): Option.Option<FieldMatch> => {
  const values = valuesOf(field.chars);
  const fieldLength = Array.length(values);
  const phrase = Array.flatten(Array.intersperse(tokens, [" "]));
  const asPhrase = Option.map(
    Option.filter(plainMatch(values, phrase), () => Array.length(tokens) > 1),
    (match): FieldMatch => ({
      ...match,
      score: scoreOf(Array.length(phrase), match) - fieldLength,
    }),
  );
  const perToken = () =>
    Option.map(
      Option.all(
        Array.map(tokens, (token) =>
          Option.map(matchToken(values, token), (match) => ({
            match,
            score: scoreOf(Array.length(token), match),
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
  return Option.orElse(asPhrase, perToken);
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

/** The query's whitespace-separated tokens, lower-cased. */
const tokensOf = (query: string): ReadonlyArray<Values> =>
  Array.map(Array.filter(String.split(String.trim(query), /\s+/), String.isNonEmpty), (token) =>
    valuesOf(charsOf(token)),
  );

/** The node's best match for the tokens, over all its fields. */
const bestOf = (
  entry: IndexedEntry,
  order: number,
  tokens: ReadonlyArray<Values>,
): Option.Option<Ranked> =>
  Option.map(
    Array.head(
      Array.sort(
        Array.getSomes(
          Array.map(entry.fields, (field) =>
            Option.map(matchField(field, tokens), (match): SearchResult => ({
              field: field.kind,
              matchClass: match.matchClass,
              node: entry.node,
              ranges: rangesOf(field.chars, match.indexes),
              score: match.score,
              text: field.text,
            })),
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
  return Array.match(tokens, {
    onEmpty: () => [],
    onNonEmpty: () =>
      Array.map(
        Array.sortWith(
          Array.getSomes(Array.map(index.entries, (entry, order) => bestOf(entry, order, tokens))),
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
