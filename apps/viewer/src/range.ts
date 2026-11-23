import { Array, Number, Result, Schema, String } from "effect";

/** A half-open range of UTF-16 code units in a field's text. */
export const Range = Schema.Struct({ end: Schema.Int, start: Schema.Int });
export type Range = typeof Range.Type;

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

/**
 * The part of each range that lies in `[from, to)`, measured from `from`: the ranges of a piece of
 * the text. A range outside the piece is dropped and one that crosses its edge is cut there.
 */
export const withinOf = (
  ranges: ReadonlyArray<Range>,
  from: number,
  to: number,
): ReadonlyArray<Range> =>
  Array.filterMap(ranges, (range) => {
    const start = Number.max(range.start, from);
    const end = Number.min(range.end, to);
    return start < end ? Result.succeed({ end: end - from, start: start - from }) : Result.failVoid;
  });
