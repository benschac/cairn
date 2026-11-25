import { Array, Option, Predicate, Result, String, pipe } from "effect";
import { parse } from "pele";

import { linesOf } from "./section-ids.ts";

/**
 * The parser's error for a Mermaid block, or nothing when it draws.
 *
 * `pele` parses synchronously and needs no DOM, so this runs in Node, in lint and in tests.
 * It parses with the same library the viewer draws with, so a block that passes here draws there.
 */
export const drawsOf = (mermaid: string): Option.Option<string> =>
  pipe(
    Result.try({
      catch: (error) => (Predicate.isError(error) ? error.message : "The diagram did not parse"),
      try: () => parse(mermaid),
    }),
    Result.getFailure,
  );

/** A fenced block tagged `mermaid` in a markdown document. */
export interface MermaidBlock {
  /** The 0-based index of the line one past the block: its closing fence, or the end of the document when it has none. */
  readonly end: number;
  /** What is between the fences, as `drawsOf` takes it. */
  readonly source: string;
  /** The 0-based index of the line of its opening fence. */
  readonly start: number;
}

/** A fence line: its delimiter, the first word of its info string and whatever follows that. */
const FENCE_LINE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)(.*)$/u;

interface Fence {
  readonly delimiter: string;
  readonly language: string;
  readonly rest: string;
}

const fenceOf = (line: string): Option.Option<Fence> =>
  Option.map(
    Option.fromNullOr(FENCE_LINE.exec(line)),
    ([, delimiter = "", language = "", rest = ""]) => ({ delimiter, language, rest }),
  );

interface Scan {
  readonly blocks: ReadonlyArray<MermaidBlock>;
  /** The fence that is open, with its delimiter and whether it is a Mermaid one. */
  readonly open: Option.Option<{
    readonly delimiter: string;
    readonly mermaid: boolean;
    readonly start: number;
  }>;
}

/**
 * Whether `fence` closes one opened with `opening`: a run of the same character at least as long,
 * with nothing after it. Delimiters are runs of one character, so that is what `startsWith` says.
 */
const closes = (opening: string, fence: Fence) =>
  String.startsWith(opening)(fence.delimiter) &&
  String.isEmpty(fence.language) &&
  String.isEmpty(String.trim(fence.rest));

/**
 * The Mermaid blocks of `markdown`, top to bottom. A fence opens at a fence line outside a fence
 * and closes at a line of the same character, as long and with no info string, as CommonMark has
 * it, so a Mermaid fence quoted inside a longer fence is not found. A block with no closing fence
 * runs to the end of the document. A fence inside a blockquote is not found.
 */
export const mermaidBlocksOf = (markdown: string): ReadonlyArray<MermaidBlock> => {
  const lines = linesOf(markdown);
  const sourceOf = (start: number, end: number) =>
    Array.join(Array.take(Array.drop(lines, start + 1), end - start - 1), "\n");
  const scanned = Array.reduce(
    lines,
    { blocks: [], open: Option.none() } satisfies Scan as Scan,
    (scan, line, index): Scan =>
      Option.match(fenceOf(line), {
        onNone: () => scan,
        onSome: (fence) =>
          Option.match(scan.open, {
            onNone: () => ({
              blocks: scan.blocks,
              open: Option.some({
                delimiter: fence.delimiter,
                mermaid: String.toLowerCase(fence.language) === "mermaid",
                start: index,
              }),
            }),
            onSome: ({ delimiter, mermaid, start }) =>
              closes(delimiter, fence)
                ? {
                    blocks: mermaid
                      ? Array.append(scan.blocks, {
                          end: index + 1,
                          source: sourceOf(start, index),
                          start,
                        })
                      : scan.blocks,
                    open: Option.none(),
                  }
                : scan,
          }),
      }),
  );
  return Option.match(scanned.open, {
    onNone: () => scanned.blocks,
    onSome: ({ mermaid, start }) =>
      mermaid
        ? Array.append(scanned.blocks, {
            end: Array.length(lines),
            source: sourceOf(start, Array.length(lines)),
            start,
          })
        : scanned.blocks,
  });
};

/** `markdown` without the lines of `blocks`, fences included. Nothing else changes. */
export const withoutMermaidBlocks = (
  markdown: string,
  blocks: ReadonlyArray<MermaidBlock>,
): string =>
  pipe(
    linesOf(markdown),
    Array.filter(
      (_, index) => !Array.some(blocks, (block) => index >= block.start && index < block.end),
    ),
    Array.join("\n"),
  );
