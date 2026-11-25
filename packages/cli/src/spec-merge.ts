import type { Section, SpecSectionId } from "@cairn/contract";
import { sectionsOf } from "@cairn/core";
import { Array, HashSet, Number, Option, Result, String, pipe } from "effect";

/** The `Under` key a new section carries in the reply of `Planner.sections`: the section it goes under. */
const UNDER = /^- Under:\s*`([^`]+)`/u;

/** The section that closes the spec: a new section with no place goes above it. */
const ACCEPTANCE = "spec.acceptance";

/** The deepest heading Markdown has. */
const MAX_LEVEL = 6;

const isBlank = (line: string) => String.isEmpty(String.trim(line));

/** The lines without the blank ones at the end. */
const withoutTrailingBlanks = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.reverse(Array.dropWhile(Array.reverse(lines), isBlank));

/** A heading line with its level changed. The text and the ID stay. */
const withLevel = (line: string, level: number) =>
  pipe(line, String.replace(/^#+/u, String.repeat(level)("#")));

/** A heading line without its `{#id}`, which `assignSectionIds` makes again. */
const withoutId = (line: string) => pipe(line, String.replace(/[ \t]*\{#[^}\s]+\}[ \t]*$/u, ""));

/** The lines with the first one, a heading, without its `{#id}`. */
const withoutIdOnFirst = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.match(lines, {
    onEmpty: () => lines,
    onNonEmpty: (all) => Array.prepend(Array.tailNonEmpty(all), withoutId(Array.headNonEmpty(all))),
  });

/** The line (0-based) where the text of section `at` ends: at the next heading of any level, or at the end. */
const endOf = (sections: ReadonlyArray<Section>, at: number, length: number) =>
  Option.getOrElse(
    Option.map(Array.get(sections, at + 1), (next) => next.line - 1),
    () => length,
  );

/** A part of the planner's reply that starts at a heading: one section with the ones nested in it. */
interface Chunk {
  readonly id: Option.Option<string>;
  readonly level: number;
  readonly lines: ReadonlyArray<string>;
  /** The headings in `lines`, whose `line` counts from the chunk's first line. */
  readonly sections: ReadonlyArray<Section>;
  readonly under: Option.Option<string>;
}

/** The lines of the key list that opens a section, with their place in the document: the list items after the heading, up to the first line of prose. A fenced example is not in it. */
const keyListOf = (lines: ReadonlyArray<string>, heading: number, end: number) =>
  Array.takeWhile(
    Array.map(Array.take(Array.drop(lines, heading + 1), end - heading - 1), (text, from) => ({
      at: heading + 1 + from,
      text,
    })),
    ({ text }) => isBlank(text) || String.startsWith("- ")(text),
  );

/**
 * Cuts the planner's reply into chunks. A chunk starts at a heading that carries an `Under` key,
 * at the first heading, at a heading that is not deeper than the chunk before it, and at a heading
 * that has the ID of a section the spec already has. Text before the first heading is left out,
 * and so is every `Under` line in a section's key list; one in a fenced example stays.
 */
const chunksOf = (fragment: string, existing: HashSet.HashSet<string>): ReadonlyArray<Chunk> => {
  const lines = String.split(fragment, "\n");
  const sections = sectionsOf(fragment);
  const heads = Array.map(sections, (section, at) => {
    const underAt = Array.findFirst(
      keyListOf(lines, section.line - 1, endOf(sections, at, Array.length(lines))),
      (line) => UNDER.test(line.text),
    );
    return {
      at: section.line - 1,
      section,
      under: underAt.pipe(
        Option.flatMap((line) => String.match(UNDER)(line.text)),
        Option.flatMap(Array.get(1)),
      ),
      underAt: Option.map(underAt, (line) => line.at),
    };
  });
  const underLines = HashSet.fromIterable(Array.getSomes(Array.map(heads, (head) => head.underAt)));
  const begins = Array.mapAccum(heads, Option.none<number>(), (top, head) => {
    const starts =
      Option.isNone(top) ||
      Option.isSome(head.under) ||
      Option.exists(top, (level) => head.section.level <= level) ||
      Option.exists(Option.fromUndefinedOr(head.section.id), (id) => HashSet.has(existing, id));
    return [starts ? Option.some(head.section.level) : top, starts] as const;
  })[1];
  const starts = Array.filterMap(Array.zip(heads, begins), ([head, starting]) =>
    starting ? Result.succeed(head) : Result.failVoid,
  );
  return Array.map(starts, (head, at) => {
    const end = Option.getOrElse(
      Option.map(Array.get(starts, at + 1), (next) => next.at),
      () => Array.length(lines),
    );
    const text = Array.map(
      Array.filter(
        Array.map(Array.take(Array.drop(lines, head.at), end - head.at), (line, from) => ({
          at: head.at + from,
          line,
        })),
        ({ at: position }) => !HashSet.has(underLines, position),
      ),
      ({ line }) => line,
    );
    return {
      id: Option.fromUndefinedOr(head.section.id),
      level: head.section.level,
      lines: withoutTrailingBlanks(text),
      sections: sectionsOf(Array.join(text, "\n")),
      under: head.under,
    };
  });
};

/** The lines from `from` up to `to` replaced by `block`. */
const spliced = (
  lines: ReadonlyArray<string>,
  from: number,
  to: number,
  block: ReadonlyArray<string>,
) => Array.flatten([Array.take(lines, from), block, Array.drop(lines, to)]);

/** The section with `id` in a document of `lines`, with the position of its heading among all headings. */
const found = (lines: ReadonlyArray<string>, id: string) => {
  const sections = sectionsOf(Array.join(lines, "\n"));
  return Array.findFirstIndex(sections, (section) => section.id === id).pipe(
    Option.flatMap((at) =>
      Option.map(Array.get(sections, at), (section) => ({ at, sections, section })),
    ),
  );
};

/**
 * A section written again: its heading as it is and the body of the chunk, up to the chunk's own
 * first sub-section, which is left out. Its place and its children stay.
 */
const rewritten = (lines: ReadonlyArray<string>, chunk: Chunk): ReadonlyArray<string> =>
  Option.match(
    Option.flatMap(chunk.id, (id) => found(lines, id)),
    {
      onNone: () => lines,
      onSome: ({ at, section, sections }) =>
        spliced(
          lines,
          section.line - 1,
          endOf(sections, at, Array.length(lines)),
          Array.flatten([
            [Option.getOrElse(Array.get(lines, section.line - 1), () => "")],
            Array.take(
              Array.drop(chunk.lines, 1),
              endOf(chunk.sections, 0, Array.length(chunk.lines)) - 1,
            ),
            [""],
          ]),
        ),
    },
  );

/** The chunk's lines with every heading moved by `delta` levels. */
const shifted = (chunk: Chunk, delta: number): ReadonlyArray<string> =>
  Array.map(chunk.lines, (line, at) =>
    Option.match(
      Array.findFirst(chunk.sections, (section) => section.line - 1 === at),
      {
        onNone: () => line,
        onSome: (section) =>
          withLevel(line, Number.clamp({ maximum: MAX_LEVEL, minimum: 1 })(section.level + delta)),
      },
    ),
  );

/**
 * A new chunk put where its `Under` says: after the last child of that section, one level deeper.
 * Without a place it goes above `spec.acceptance`, or at the end.
 */
const inserted = (lines: ReadonlyArray<string>, chunk: Chunk): ReadonlyArray<string> => {
  const parent = Option.flatMap(chunk.under, (id) => found(lines, id));
  const [at, delta] = Option.match(parent, {
    onNone: () =>
      [
        Option.match(found(lines, ACCEPTANCE), {
          onNone: () => Array.length(lines),
          onSome: ({ section }) => section.line - 1,
        }),
        0,
      ] as const,
    onSome: ({ at: position, section, sections }) =>
      [
        Option.match(
          Array.findFirst(
            Array.drop(sections, position + 1),
            (below) => below.level <= section.level,
          ),
          { onNone: () => Array.length(lines), onSome: (below) => below.line - 1 },
        ),
        section.level + 1 - chunk.level,
      ] as const,
  });
  const before = Array.get(lines, at - 1);
  const lead = Option.exists(before, (line) => !isBlank(line)) ? [""] : [];
  return spliced(lines, at, at, Array.flatten([lead, shifted(chunk, delta), [""]]));
};

/** The sections nested in a chunk, as a chunk of their own under the chunk's section: the new children of a rewritten section. */
const childrenOf = (chunk: Chunk): Option.Option<Chunk> =>
  Option.map(Array.get(chunk.sections, 1), (first) => {
    const lines = Array.drop(chunk.lines, first.line - 1);
    return {
      id: Option.fromUndefinedOr(first.id),
      level: first.level,
      lines,
      sections: sectionsOf(Array.join(lines, "\n")),
      under: chunk.id,
    };
  });

/** A new chunk put in its place, without the ID of a section the spec already has. */
const placed = (
  lines: ReadonlyArray<string>,
  chunk: Chunk,
  existing: HashSet.HashSet<string>,
): ReadonlyArray<string> =>
  inserted(
    lines,
    Option.exists(chunk.id, (id) => HashSet.has(existing, id))
      ? { ...chunk, lines: withoutIdOnFirst(chunk.lines) }
      : chunk,
  );

/** What `mergeSections` made of the spec and the planner's reply. */
export interface Merged {
  readonly markdown: string;
  /** The sections of `rewritable` the reply wrote again. */
  readonly rewritten: ReadonlyArray<SpecSectionId>;
}

/**
 * Puts the sections of `fragment`, the reply of `Planner.sections`, into `spec` (see
 * `spec.planning.again`). A section with the ID of one in `rewritable` replaces that section's
 * own text and keeps its heading and its place; sections the reply nests in it are new and go
 * under it. Any other section is new: it goes under the
 * existing section its `Under` line names, after that section's last child, and one level
 * deeper than it; with no `Under` that names a section it goes above `spec.acceptance`, or last.
 * A new section whose ID the spec already has loses it, so that `assignSectionIds` gives it
 * another. The result is not checked: a section in it may still lack an ID.
 */
export const mergeSections = (
  spec: string,
  fragment: string,
  rewritable: ReadonlyArray<SpecSectionId>,
): Merged => {
  const existing = HashSet.fromIterable<string>(
    Array.getSomes(Array.map(sectionsOf(spec), (section) => Option.fromUndefinedOr(section.id))),
  );
  const again = Array.filter(rewritable, (id) => HashSet.has(existing, id));
  const chunks = chunksOf(fragment, existing);
  const rewrites = (chunk: Chunk) => Option.exists(chunk.id, (id) => Array.contains(again, id));
  const lines = Array.reduce(
    chunks,
    withoutTrailingBlanks(String.split(spec, "\n")),
    (current, chunk) =>
      rewrites(chunk)
        ? Option.match(childrenOf(chunk), {
            onNone: () => rewritten(current, chunk),
            onSome: (children) => placed(rewritten(current, chunk), children, existing),
          })
        : placed(current, chunk, existing),
  );
  return {
    markdown: Array.join(withoutTrailingBlanks(lines), "\n"),
    rewritten: Array.filter(again, (id) =>
      Array.some(chunks, (chunk) => rewrites(chunk) && Option.contains(chunk.id, id)),
    ),
  };
};
