import { Array, Schema, String } from "effect";

/** A half-open range of UTF-16 code units in a piece of text. */
export const Range = Schema.Struct({ end: Schema.Int, start: Schema.Int });
export type Range = typeof Range.Type;

/** A stretch of a text, and whether the query matched it. */
export interface Segment {
  readonly isMatch: boolean;
  readonly text: string;
}

/**
 * A text cut at the ends of its matched ranges, in order, without empty pieces. Joining the
 * segments gives the text back, and joining the matched ones gives the matched characters.
 */
export const segmentsOf = (text: string, ranges: ReadonlyArray<Range>): ReadonlyArray<Segment> => {
  const { end, segments } = Array.reduce(
    ranges,
    { end: 0, segments: Array.empty<Segment>() },
    (cut, range) => ({
      end: range.end,
      segments: Array.appendAll(cut.segments, [
        { isMatch: false, text: String.slice(cut.end, range.start)(text) },
        { isMatch: true, text: String.slice(range.start, range.end)(text) },
      ]),
    }),
  );
  return Array.filter(
    Array.append(segments, { isMatch: false, text: String.slice(end)(text) }),
    (segment) => String.isNonEmpty(segment.text),
  );
};
