import { PrdSectionId, type SectionPrefix, type Trace, type TraceSection } from "@cairn/contract";
import { Array, MutableRef, Number, Option, Order, Record, Schema, String, pipe } from "effect";

import { documentOf, type Marks, type MarkdownDocument } from "./markdown.ts";
import { Range, withinOf } from "./range.ts";
import { Node, nodeKeyOf } from "./trace.ts";

/**
 * Which text of a node matched. Within one match class a title outranks an id, an id a branch,
 * and a branch prose. A section's prose is one field for each paragraph, list paragraph or table
 * cell under its heading, so a query has to match within one of them.
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
 * A piece of visible text a query can match. A prose field also says where its block starts in its
 * document's markdown, which is how the rendered block is found again.
 */
export const SearchField = Schema.Struct({
  kind: FieldKind,
  maybeOffset: Schema.Option(Schema.Int),
  text: Schema.String,
});
export type SearchField = typeof SearchField.Type;

/** A field that is not a block of prose. */
export const fieldOf = (kind: FieldKind, text: string): SearchField => ({
  kind,
  maybeOffset: Option.none(),
  text,
});

/** One node and the text searched for it. Its place in the content is its source order. */
export const SearchEntry = Schema.Struct({ fields: Schema.Array(SearchField), node: Node });
export type SearchEntry = typeof SearchEntry.Type;

/** What the index is built from. The index changes only when this does. */
export const SearchContent = Schema.Array(SearchEntry);
export type SearchContent = typeof SearchContent.Type;

const sameContent = Schema.toEquivalence(SearchContent);

/** One node's best match: the field it matched, how, and where in that field's text. */
export const SearchResult = Schema.Struct({
  field: FieldKind,
  matchClass: MatchClass,
  /** Where the block starts in its document's markdown, when the field is a block of prose. */
  maybeOffset: Schema.Option(Schema.Int),
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
  /** The values as one string, which the engine searches natively. */
  readonly joined: string;
  readonly kind: FieldKind;
  readonly maybeOffset: Option.Option<number>;
  readonly text: string;
  /** The lower-cased code points of `chars`, which is all a comparison reads. */
  readonly values: ReadonlyArray<string>;
  /** The indexes into `values` at which a word starts. */
  readonly wordStarts: ReadonlyArray<number>;
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

/**
 * A section's fields: its title as the page shows it, its ID, then its prose. The document supplies
 * the title and the prose, taken from its parse, so a title with inline code reads as it renders.
 */
const sectionEntryOf =
  (document: MarkdownDocument) =>
  (section: TraceSection): SearchEntry => ({
    fields: Array.appendAll(
      [
        fieldOf(
          "title",
          Option.getOrElse(Record.get(document.titles, section.id), () => section.title),
        ),
        fieldOf("id", section.id),
      ],
      Array.map(
        Option.getOrElse(Record.get(document.blocks, section.id), () => []),
        (block): SearchField => ({
          kind: "prose",
          maybeOffset: Option.some(block.offset),
          text: block.text,
        }),
      ),
    ),
    node: { id: section.id, kind: "section" },
  });

/**
 * The searchable text of a trace: titles, ids and prose of both documents' sections, and tasks.
 * The documents are parsed once per text, here and by the renderer alike.
 */
export const searchContentOf = (trace: Trace): SearchContent =>
  Array.appendAll(
    Array.appendAll(
      Array.map(trace.prd.sections, sectionEntryOf(documentOf(trace.prd.markdown))),
      Array.map(trace.spec.sections, sectionEntryOf(documentOf(trace.spec.markdown))),
    ),
    Array.map(trace.tasks, (task) => ({
      fields: [
        fieldOf("title", task.title),
        fieldOf("id", task.id),
        fieldOf("branch", task.branch),
      ],
      node: { id: task.id, kind: "task" as const },
    })),
  );

type Values = ReadonlyArray<string>;

/** A query word, or the words joined: the lower-cased code points and the same as one string. */
interface Token {
  readonly text: string;
  readonly values: Values;
}

const tokenOf = (values: Values): Token => ({ text: Array.join(values, ""), values });

/** What a search compares each field with: the words, and the words as one phrase. */
interface Query {
  readonly phrase: Token;
  readonly tokens: Array.NonEmptyReadonlyArray<Token>;
}

const valuesOf = (chars: ReadonlyArray<Char>): Values => Array.map(chars, (char) => char.value);

/** Normalises every field once, so a query only compares. */
export const buildIndex = (content: SearchContent): SearchIndex => ({
  content,
  entries: Array.map(content, (entry) => ({
    fields: Array.map(entry.fields, (field) => {
      const chars = charsOf(field.text);
      const values = valuesOf(chars);
      return {
        ...field,
        chars,
        joined: Array.join(values, ""),
        values,
        wordStarts: wordStartsOf(values),
      };
    }),
    key: nodeKeyOf(entry.node),
    node: entry.node,
  })),
});

interface Cached {
  readonly index: SearchIndex;
  readonly trace: Trace;
}

const cache = MutableRef.make<Option.Option<Cached>>(Option.none());

/**
 * The index for a trace. It is kept until the searchable content changes, so a refresh that only
 * moves statuses, and every query, reuse it. The trace a query is over is almost always the one the
 * last query was over, so that is checked first and the content is only rebuilt for another trace.
 */
export const indexOf = (trace: Trace): SearchIndex =>
  Option.match(
    Option.filter(MutableRef.get(cache), (cached) => cached.trace === trace),
    {
      onNone: () => {
        const content = searchContentOf(trace);
        const index = Option.getOrElse(
          Option.filter(
            Option.map(MutableRef.get(cache), (cached) => cached.index),
            (kept) => sameContent(kept.content, content),
          ),
          () => buildIndex(content),
        );
        MutableRef.set(cache, Option.some({ index, trace }));
        return index;
      },
      onSome: (cached) => cached.index,
    },
  );

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

/** The `size` values from `start`, or fewer at the end. Unlike dropping first, it copies only the window. */
const windowAt = (field: Values, start: number, size: number): Values =>
  Array.getSomes(Array.makeBy(size, (offset) => Array.get(field, start + offset)));

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
        const window = windowAt(field, start, size);
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

/** The index among the code points of `joined` of the code unit at `unitIndex`. */
const valueIndexOf = (joined: string, unitIndex: number): number =>
  Array.length(Array.fromIterable(String.slice(0, unitIndex)(joined)));

/**
 * Exact, prefix or contiguous: the matches that need no tolerance. They are searched for in the
 * field's joined text, which the engine does natively, and only a hit is turned back into indexes.
 */
const plainMatch = (field: IndexedField, token: Token): Option.Option<Match> => {
  const size = Array.length(token.values);
  const at = (matchClass: MatchClass, start: number): Match => ({
    indexes: run(start, size),
    matchClass,
  });
  return pipe(
    Option.map(
      Option.liftPredicate(field.joined, (joined) => joined === token.text),
      () => at("exact", 0),
    ),
    Option.orElse(() =>
      Option.map(Option.liftPredicate(field.joined, String.startsWith(token.text)), () =>
        at("prefix", 0),
      ),
    ),
    Option.orElse(() =>
      Option.map(String.indexOf(token.text)(field.joined), (unitIndex) =>
        at("contiguous", valueIndexOf(field.joined, unitIndex)),
      ),
    ),
  );
};

/** A token needs four characters before a typo is allowed. */
const TYPO_LENGTH = 4;

/** A cheap necessary condition for a one-edit match, so most fields skip the window scan. */
const sharesAllButOne = (field: IndexedField, token: Token): boolean =>
  Array.length(Array.filter(token.values, (value) => String.includes(value)(field.joined))) >=
  Array.length(token.values) - 1;

/**
 * The starts a one-edit window can have: the start of a word, whose first two characters hold the
 * token's first or second one, since one edit leaves one of them in place. A typo is a word spelt
 * a little wrong, so the window does not need to begin inside a word.
 */
const typoStarts = (field: IndexedField, token: Token): ReadonlyArray<number> => {
  const wanted = Array.take(token.values, 2);
  const isWanted = (index: number) =>
    Option.exists(Array.get(field.values, index), (value) => Array.contains(wanted, value));
  return Array.filter(field.wordStarts, (start) => isWanted(start) || isWanted(start + 1));
};

const isWordCharacter = (value: string): boolean => /[\p{L}\p{M}\p{N}]/u.test(value);

/** The indexes at which a word starts: a word character after something that is not one. */
const wordStartsOf = (values: Values): ReadonlyArray<number> =>
  Array.filter(
    Array.makeBy(Array.length(values), (index) => index),
    (index) =>
      Option.exists(Array.get(values, index), isWordCharacter) &&
      !Option.exists(Array.get(values, index - 1), isWordCharacter),
  );

/** The match widened to the whole word it sits in, so a typo marks the word the query was aiming at. */
const wordAround = (field: Values, match: Match): Match =>
  Option.match(Option.all({ first: Array.head(match.indexes), last: Array.last(match.indexes) }), {
    onNone: () => match,
    onSome: ({ first, last }) => {
      const before = Array.length(
        Array.takeWhile(Array.reverse(Array.take(field, first)), isWordCharacter),
      );
      const after = Array.length(Array.takeWhile(Array.drop(field, last + 1), isWordCharacter));
      return {
        indexes: run(first - before, last - first + 1 + before + after),
        matchClass: match.matchClass,
      };
    },
  });

/**
 * A token's match in a field. A subsequence is an abbreviation, which only means something in a
 * short field; in a paragraph it would match nearly any query, so prose has none.
 */
const matchToken = (
  field: IndexedField,
  token: Token,
  allowsSubsequence: boolean,
): Option.Option<Match> => {
  const size = Array.length(token.values);
  return pipe(
    plainMatch(field, token),
    Option.orElse(() =>
      size >= TYPO_LENGTH && sharesAllButOne(field, token)
        ? Option.map(
            runOf(
              field.values,
              typoStarts(field, token),
              "typo",
              [size, size - 1, size + 1],
              (window) => withinOneEdit(token.values, window),
            ),
            (match) => wordAround(field.values, match),
          )
        : Option.none(),
    ),
    Option.orElse(() =>
      allowsSubsequence ? subsequenceOf(field.values, token.values) : Option.none(),
    ),
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

interface ScoredMatch {
  readonly match: Match;
  readonly score: number;
}

/**
 * Every token has to match this one field, and the first that does not ends the search of it. A
 * multi-word query that appears as a phrase counts as a phrase, so an exact title beats a title
 * that merely contains each word.
 */
const matchField = (field: IndexedField, query: Query): Option.Option<FieldMatch> => {
  const fieldLength = Array.length(field.values);
  const asPhrase = Option.map(
    Array.length(query.tokens) > 1 ? plainMatch(field, query.phrase) : Option.none(),
    (match): FieldMatch => ({
      ...match,
      score: scoreOf(Array.length(query.phrase.values), match) - fieldLength,
    }),
  );
  const perToken = () =>
    Option.map(
      Array.reduce(query.tokens, Option.some(Array.empty<ScoredMatch>()), (matched, token) =>
        Option.flatMap(matched, (matches) =>
          Option.map(matchToken(field, token, field.kind !== "prose"), (match) =>
            Array.append(matches, { match, score: scoreOf(Array.length(token.values), match) }),
          ),
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

/** How well one field matched: the three things that order matches. */
interface Quality {
  readonly kind: FieldKind;
  readonly matchClass: MatchClass;
  readonly score: number;
}

/** Match class first, then title before id before branch before prose, then the higher score. */
const qualityOrder: Order.Order<Quality> = Order.combineAll([
  Order.mapInput(Order.Number, (quality: Quality) => classRank[quality.matchClass]),
  Order.mapInput(Order.Number, (quality: Quality) => fieldRank[quality.kind]),
  Order.flip(Order.mapInput(Order.Number, (quality: Quality) => quality.score)),
]);

const resultOrder: Order.Order<SearchResult> = Order.mapInput(
  qualityOrder,
  (result: SearchResult): Quality => ({
    kind: result.field,
    matchClass: result.matchClass,
    score: result.score,
  }),
);

interface Candidate {
  readonly field: IndexedField;
  readonly match: FieldMatch;
}

const candidateOrder: Order.Order<Candidate> = Order.mapInput(
  qualityOrder,
  ({ field, match }: Candidate): Quality => ({
    kind: field.kind,
    matchClass: match.matchClass,
    score: match.score,
  }),
);

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

/** The query's whitespace-separated tokens, lower-cased; none for a blank query. */
const queryOf = (text: string): Option.Option<Query> =>
  Option.map(
    Array.match(
      Array.map(Array.filter(String.split(String.trim(text), /\s+/), String.isNonEmpty), (token) =>
        tokenOf(valuesOf(charsOf(token))),
      ),
      { onEmpty: () => Option.none(), onNonEmpty: Option.some },
    ),
    (tokens) => ({
      phrase: tokenOf(
        Array.flatten(
          Array.intersperse(
            Array.map(tokens, (token) => token.values),
            [" "],
          ),
        ),
      ),
      tokens,
    }),
  );

/**
 * The node's best match for the query, over all its fields. The fields are compared first and only
 * the best has its ranges worked out, so a section with many paragraphs pays for one.
 */
const bestOf = (entry: IndexedEntry, order: number, query: Query): Option.Option<Ranked> =>
  Option.map(
    Array.head(
      Array.sort(
        Array.getSomes(
          Array.map(entry.fields, (field) =>
            Option.map(matchField(field, query), (match): Candidate => ({ field, match })),
          ),
        ),
        candidateOrder,
      ),
    ),
    ({ field, match }): Ranked => ({
      key: entry.key,
      order,
      result: {
        field: field.kind,
        matchClass: match.matchClass,
        maybeOffset: field.maybeOffset,
        node: entry.node,
        ranges: rangesOf(field.chars, match.indexes),
        score: match.score,
        text: field.text,
      },
    }),
  );

/**
 * The nodes a query matches, best first, one result each with the field that matched best. An
 * empty or blank query matches nothing.
 */
export const search = (index: SearchIndex, query: string): ReadonlyArray<SearchResult> =>
  Option.match(queryOf(query), {
    onNone: () => [],
    onSome: (parsed) =>
      Array.map(
        Array.sort(
          Array.getSomes(Array.map(index.entries, (entry, order) => bestOf(entry, order, parsed))),
          rankedOrder,
        ),
        (ranked) => ranked.result,
      ),
  });

/**
 * The results for a query over a trace, building the index only if the content changed. A blank
 * query matches nothing and builds nothing, so a refresh with no search never touches the prose.
 */
export const searchTrace = (trace: Trace, query: string): ReadonlyArray<SearchResult> =>
  String.isEmpty(String.trim(query)) ? [] : search(indexOf(trace), query);

/** The most text a result's snippet shows, and how much of it comes before the first match. */
const SNIPPET_LENGTH = 120;
const SNIPPET_LEAD = 40;

/** A bounded stretch of a matched field, with the ranges that fall in it. */
export interface Snippet {
  /** The field's text goes on after the snippet. */
  readonly isCutAfter: boolean;
  /** The field's text goes on before the snippet. */
  readonly isCutBefore: boolean;
  /** In the snippet's text, not the field's. */
  readonly ranges: ReadonlyArray<Range>;
  readonly text: string;
}

/** An index that does not fall inside a surrogate pair: the pair's start when it does. */
const boundaryAt = (text: string, index: number): number =>
  Option.exists(String.codePointAt(index)(text), (unit) => unit >= 0xdc00 && unit <= 0xdfff)
    ? index - 1
    : index;

/**
 * The context of a result's best match: its whole text when that is short, otherwise a window of
 * at most 120 UTF-16 units that starts a little before the first match, cut on code point
 * boundaries. The ranges are those of the result, cut to the window.
 */
export const snippetOf = (result: SearchResult): Snippet => {
  const length = String.length(result.text);
  const first = Option.getOrElse(
    Option.map(Array.head(result.ranges), (range) => range.start),
    () => 0,
  );
  const from = boundaryAt(
    result.text,
    Number.max(0, Number.min(first - SNIPPET_LEAD, length - SNIPPET_LENGTH)),
  );
  const to = boundaryAt(result.text, Number.min(length, from + SNIPPET_LENGTH));
  return {
    isCutAfter: to < length,
    isCutBefore: from > 0,
    ranges: withinOf(result.ranges, from, to),
    text: String.slice(from, to)(result.text),
  };
};

const isPrdSection = Schema.is(PrdSectionId);

/**
 * The name of a measured prose block: its document and its offset there. Layout measures a marked
 * block under this key, so a result can be brought into view at its block and not only its section.
 */
export const blockKeyFor = (document: SectionPrefix, offset: number): string =>
  `${document}:${offset}`;

/** The key of a result's prose block; none for a result that matched a title, an ID or a branch. */
export const blockKeyOf = (result: SearchResult): Option.Option<string> =>
  Option.flatMap(result.maybeOffset, (offset) =>
    Node.match(result.node, {
      section: ({ id }) => Option.some(blockKeyFor(isPrdSection(id) ? "prd" : "spec", offset)),
      task: () => Option.none(),
    }),
  );

/** The ranges the results matched in one document's section titles and prose blocks. */
export const marksOf = (document: SectionPrefix, results: ReadonlyArray<SearchResult>): Marks => {
  const own = Array.filter(
    results,
    (result) => result.node.kind === "section" && String.startsWith(`${document}.`)(result.node.id),
  );
  return {
    blocks: Record.fromIterableWith(
      Array.filter(own, (result) => Option.isSome(result.maybeOffset)),
      (result) => [`${Option.getOrElse(result.maybeOffset, () => 0)}`, result.ranges],
    ),
    titles: Record.fromIterableWith(
      Array.filter(own, (result) => result.field === "title"),
      (result) => [result.node.id, result.ranges],
    ),
  };
};

// SEARCH STATE

/**
 * This window's search: the query, what it finds, and the result whose chain is previewed.
 */
export const SearchState = Schema.Struct({
  maybeActive: Schema.Option(Node),
  query: Schema.String,
  results: Schema.Array(SearchResult),
});
export type SearchState = typeof SearchState.Type;

export const NO_SEARCH: SearchState = {
  maybeActive: Option.none(),
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
    query,
    results,
  };
};

/** A new query starts again at its first result. */
export const queried = (
  state: SearchState,
  maybeTrace: Option.Option<Trace>,
  query: string,
): SearchState => derive(state, maybeTrace, query, Option.none());

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

/** A found node becomes the active result; any other is ignored. */
export const chosen = (state: SearchState, node: Node): SearchState =>
  isFound(state.results, node) ? { ...state, maybeActive: Option.some(node) } : state;
