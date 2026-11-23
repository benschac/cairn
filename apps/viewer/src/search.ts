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
export const Range = Schema.Struct({ end: Schema.Int, start: Schema.Int });
export type Range = typeof Range.Type;

/** One node's best match: the field it matched, how, and where in that field's text. */
export const SearchResult = Schema.Struct({
  field: FieldKind,
  matchClass: MatchClass,
  node: Node,
  /** Sorted, non-overlapping, on code point boundaries of `text`. */
  ranges: Schema.Array(Range),
  /** Higher is better, comparable within one match class and field kind. */
  score: Schema.Finite,
  text: Schema.String,
});
export type SearchResult = typeof SearchResult.Type;

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
  /** The lower-cased code points of `chars`, which is all a comparison reads. */
  readonly values: ReadonlyArray<string>;
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
      value: lower,
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

type Values = ReadonlyArray<string>;

const valuesOf = (chars: ReadonlyArray<Char>): Values => Array.map(chars, (char) => char.value);

/** Normalises every field once, so a query only compares. */
export const buildIndex = (content: SearchContent): SearchIndex => ({
  content,
  entries: Array.map(content, (entry) => ({
    fields: Array.map(entry.fields, (field) => {
      const chars = charsOf(field.text);
      return { ...field, chars, values: valuesOf(chars) };
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

const sameValues = (left: Values, right: Values): boolean =>
  Array.length(left) === Array.length(right) &&
  Array.every(Array.zip(left, right), ([a, b]) => a === b);

/** A single insertion, deletion, substitution or adjacent transposition apart, or equal. */
const withinOneEdit = (token: Values, window: Values): boolean => {
  const common = Array.length(Array.takeWhile(Array.zip(token, window), ([a, b]) => a === b));
  const tokenRest = Array.drop(token, common);
  const windowRest = Array.drop(window, common);
  const tokenLength = Array.length(tokenRest);
  const windowLength = Array.length(windowRest);
  const swapped = sameValues(Array.take(tokenRest, 2), Array.reverse(Array.take(windowRest, 2)));
  return (
    (tokenLength === 0 && windowLength <= 1) ||
    (windowLength === 0 && tokenLength <= 1) ||
    (tokenLength === windowLength &&
      (sameValues(Array.drop(tokenRest, 1), Array.drop(windowRest, 1)) ||
        (swapped && sameValues(Array.drop(tokenRest, 2), Array.drop(windowRest, 2))))) ||
    (tokenLength === windowLength + 1 && sameValues(Array.drop(tokenRest, 1), windowRest)) ||
    (windowLength === tokenLength + 1 && sameValues(tokenRest, Array.drop(windowRest, 1)))
  );
};

interface Match {
  readonly indexes: ReadonlyArray<number>;
  readonly matchClass: MatchClass;
}

const run = (start: number, length: number): ReadonlyArray<number> =>
  Array.makeBy(length, (offset) => start + offset);

/** Where in the field's values a token sits as a run, from the first start. */
const runOf = (
  field: Values,
  starts: ReadonlyArray<number>,
  matchClass: MatchClass,
  windowSizes: ReadonlyArray<number>,
  accepts: (window: Values) => boolean,
): Option.Option<Match> =>
  Option.map(
    Array.findFirst(
      Array.flatMap(starts, (start) => Array.map(windowSizes, (size) => ({ size, start }))),
      ({ size, start }) => {
        const window = Array.take(Array.drop(field, start), size);
        return Array.length(window) === size && accepts(window);
      },
    ),
    ({ size, start }) => ({ indexes: run(start, size), matchClass }),
  );

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
  const startsAtHead = Array.filter(
    Array.makeBy(Array.length(field), (start) => start),
    (start) =>
      Option.exists(Array.get(field, start), (value) =>
        Option.exists(Array.head(token), (head) => head === value),
      ),
  );
  const at = (accepts: (window: Values) => boolean) =>
    runOf(field, startsAtHead, "contiguous", [size], accepts);
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

/** A cheap necessary condition for a one-edit match, so most fields skip the window scan. */
const sharesAllButOne = (field: Values, token: Values): boolean =>
  Array.length(Array.filter(token, (value) => Array.contains(field, value))) >=
  Array.length(token) - 1;

const matchToken = (field: Values, token: Values): Option.Option<Match> => {
  const size = Array.length(token);
  return pipe(
    plainMatch(field, token),
    Option.orElse(() =>
      size >= TYPO_LENGTH && sharesAllButOne(field, token)
        ? runOf(
            field,
            Array.makeBy(Array.length(field) + 1, (start) => start),
            "typo",
            [size, size - 1, size + 1],
            (window) => withinOneEdit(token, window),
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
  const { values } = field;
  const fieldLength = Array.length(values);
  const phrase = Array.flatten(Array.intersperse(tokens, [" "]));
  const asPhrase = Option.map(
    Option.filter(plainMatch(values, phrase), () => Array.length(tokens) > 1),
    (match): FieldMatch => ({
      ...match,
      score: scoreOf(Array.length(phrase), match) - fieldLength,
    }),
  );
  const perToken = Option.map(
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
  return Option.orElse(asPhrase, () => perToken);
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
        Array.sort(
          Array.getSomes(Array.map(index.entries, (entry, order) => bestOf(entry, order, tokens))),
          rankedOrder,
        ),
        (ranked) => ranked.result,
      ),
  });
};

/** The results for a query over a trace, building the index only if the content changed. */
export const searchTrace = (trace: Trace, query: string): ReadonlyArray<SearchResult> =>
  search(indexOf(trace), query);

/** A stretch of a field's text: matched by the query, or not. */
export interface Segment {
  readonly isMatch: boolean;
  readonly text: string;
}

/** The text cut at the ranges, in order, with the matched stretches marked and no empty stretch. */
export const segmentsOf = (text: string, ranges: ReadonlyArray<Range>): ReadonlyArray<Segment> => {
  const [end, cut] = Array.mapAccum(ranges, 0, (from, range) => [
    range.end,
    [
      { isMatch: false, text: String.slice(from, range.start)(text) },
      { isMatch: true, text: String.slice(range.start, range.end)(text) },
    ],
  ]);
  return Array.filter(
    Array.append(Array.flatten(cut), { isMatch: false, text: String.slice(end)(text) }),
    (segment) => String.isNonEmpty(segment.text),
  );
};

// SEARCH STATE

/**
 * This window's search: the query, what it finds, the result whose chain is previewed, and the
 * result still to be brought into view once layout has measured it.
 */
export const SearchState = Schema.Struct({
  maybeActive: Schema.Option(Node),
  maybeToCenter: Schema.Option(Node),
  query: Schema.String,
  results: Schema.Array(SearchResult),
});
export type SearchState = typeof SearchState.Type;

export const NO_SEARCH: SearchState = {
  maybeActive: Option.none(),
  maybeToCenter: Option.none(),
  query: "",
  results: [],
};

const sameResults = Schema.toEquivalence(Schema.Array(SearchResult));
const sameNode = Schema.toEquivalence(Node);

const isFound = (results: ReadonlyArray<SearchResult>, node: Node): boolean =>
  Array.some(results, (result) => sameNode(result.node, node));

/** The result for a node, if the query matched it directly. */
export const resultOf = (
  results: ReadonlyArray<SearchResult>,
  node: Node,
): Option.Option<SearchResult> => Array.findFirst(results, (result) => sameNode(result.node, node));

/**
 * The state for a query over the trace, which is none until one has loaded. The results keep their
 * reference when the query finds the same, so a view built from them is reused. The active result
 * is `maybeKept` if it is still found, and otherwise the first result.
 */
const derive = (
  state: SearchState,
  maybeTrace: Option.Option<Trace>,
  query: string,
  maybeKept: Option.Option<Node>,
): SearchState => {
  const found = Option.match(maybeTrace, {
    onNone: () => [],
    onSome: (trace) => searchTrace(trace, query),
  });
  const results = sameResults(state.results, found) ? state.results : found;
  return {
    maybeActive: Option.orElse(
      Option.filter(maybeKept, (node) => isFound(results, node)),
      () => Option.map(Array.head(results), (first) => first.node),
    ),
    maybeToCenter: Option.filter(state.maybeToCenter, (node) => isFound(results, node)),
    query,
    results,
  };
};

/** A new query starts again at its first result, and brings nothing into view. */
export const queried = (
  state: SearchState,
  maybeTrace: Option.Option<Trace>,
  query: string,
): SearchState => ({
  ...derive(state, maybeTrace, query, Option.none()),
  maybeToCenter: Option.none(),
});

/** The same query over a refreshed trace: the active result stays while it is still found. */
export const refreshed = (state: SearchState, maybeTrace: Option.Option<Trace>): SearchState =>
  derive(state, maybeTrace, state.query, state.maybeActive);

/** One result up or down the list, stopping at its ends. */
export const moved = (state: SearchState, step: -1 | 1): SearchState => ({
  ...state,
  maybeActive: Option.orElse(
    Option.flatMap(
      Option.flatMap(state.maybeActive, (active) =>
        Array.findFirstIndex(state.results, (result) => sameNode(result.node, active)),
      ),
      (index) => Option.map(Array.get(state.results, index + step), (result) => result.node),
    ),
    // Past either end there is no result to move to, so the active one stays.
    () => state.maybeActive,
  ),
});

/** A found node becomes the active result and is to be brought into view; any other is ignored. */
export const chosen = (state: SearchState, node: Node): SearchState =>
  isFound(state.results, node)
    ? { ...state, maybeActive: Option.some(node), maybeToCenter: Option.some(node) }
    : state;
