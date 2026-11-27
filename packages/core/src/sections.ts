import { PrdSectionId, SectionId, SpecSectionId } from "@cairn/contract";
import type { Section, SectionKeys } from "@cairn/contract";
import { Array, Option, Predicate, Result, Schema, String, pipe } from "effect";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

import { headingsOf, linesOf } from "./section-ids.ts";

const MARKER = /<!--\s*human\s*-->/gu;
const MARKER_LINE = /^\s*<!--\s*human\s*-->\s*$/u;
const KEY_LINE = /^- (Implements|Files|Depends on|Defers|Context):(.*)$/u;
const CODE_SPAN = /`([^`]+)`/gu;

const NO_KEYS: SectionKeys = { context: [], defers: [], dependsOn: [], files: [], implements: [] };

/** A section above the one being read, kept for what its children inherit. */
interface Open {
  readonly human: boolean;
  readonly id: Option.Option<SectionId>;
  readonly keys: SectionKeys;
  readonly level: number;
}

const isBlank = (line: string): boolean => String.isEmpty(String.trim(line));

/**
 * The 0-based places in `body` of the lines of its key list. The key list opens the body: after
 * blank lines and the human marker, up to the first line of prose. A blank line between items is
 * part of the list.
 */
export const keyLineIndexesOf = (body: readonly string[]): readonly number[] => {
  const start = Array.length(
    Array.takeWhile(body, (line) => isBlank(line) || MARKER_LINE.test(line)),
  );
  return Array.filterMap(
    Array.takeWhile(Array.drop(body, start), (line) => isBlank(line) || KEY_LINE.test(line)),
    (line, at) => (KEY_LINE.test(line) ? Result.succeed(start + at) : Result.failVoid),
  );
};

/** The lines of the key list that opens the body (see `keyLineIndexesOf`). */
const keyLinesOf = (body: readonly string[]): readonly string[] =>
  Array.getSomes(Array.map(keyLineIndexesOf(body), (at) => Array.get(body, at)));

/** The backticked values of a key line. */
const valuesOf = (text: string): readonly string[] =>
  Array.flatMapNullishOr(
    Array.fromIterable(String.matchAll(CODE_SPAN)(text)),
    ([, value]) => value,
  );

/** The ids a key names; a value that is not an id of the right prefix is left out. */
const idsOf = <S extends Schema.Top & { readonly Type: string }>(
  schema: S,
  values: readonly string[],
): readonly S["Type"][] => Array.filter(values, Schema.is(schema));

/**
 * The keys a section's body lists before its prose, in order, each with every backticked value as
 * written. `lint` reads them to report a value the key leaves out because it is not an ID of the
 * key's prefix.
 */
export const keyEntriesOf = (
  body: readonly string[],
): ReadonlyArray<readonly [string, readonly string[]]> =>
  Array.getSomes(
    Array.map(keyLinesOf(body), (line) =>
      pipe(
        String.match(KEY_LINE)(line),
        Option.map(([, name = "", rest = ""]) => [name, valuesOf(rest)] as const),
      ),
    ),
  );

const ownKeysOf = (entries: ReadonlyArray<readonly [string, readonly string[]]>): SectionKeys => {
  const named = (name: string): readonly string[] =>
    Array.flatMap(entries, ([key, values]) => (key === name ? values : []));
  return {
    context: idsOf(PrdSectionId, named("Context")),
    defers: idsOf(PrdSectionId, named("Defers")),
    dependsOn: idsOf(SpecSectionId, named("Depends on")),
    files: named("Files"),
    implements: idsOf(PrdSectionId, named("Implements")),
  };
};

/** Inherited values first, then the section's own, each once. */
const mergeKeys = (inherited: SectionKeys, own: SectionKeys): SectionKeys => ({
  context: Array.dedupe(Array.appendAll(inherited.context, own.context)),
  defers: Array.dedupe(Array.appendAll(inherited.defers, own.defers)),
  dependsOn: Array.dedupe(Array.appendAll(inherited.dependsOn, own.dependsOn)),
  files: Array.dedupe(Array.appendAll(inherited.files, own.files)),
  implements: Array.dedupe(Array.appendAll(inherited.implements, own.implements)),
});

/** The 1-based line of each marker in an HTML node that starts on line `start`. An HTML block can span lines, and a heading inside it still starts a section. */
const markersInHtml = (html: string, start: number): readonly number[] =>
  Array.map(Array.fromIterable(String.matchAll(MARKER)(html)), (found) =>
    pipe(
      html,
      String.slice(
        0,
        Option.getOrElse(Option.fromNullishOr(found.index), () => 0),
      ),
      String.split("\n"),
      Array.length,
      (count) => start + count - 1,
    ),
  );

/**
 * The 1-based lines of every marker in `markdown`. A marker counts only where a Markdown parser
 * reads it as HTML, so one quoted in a code span of any length, in a fence or in indented code is
 * not a tag.
 */
export const markerLinesOf = (markdown: string): readonly number[] => {
  const walk = (node: Nodes): readonly number[] =>
    Array.appendAll(
      node.type === "html"
        ? markersInHtml(
            node.value,
            Option.getOrElse(Option.fromNullishOr(node.position?.start.line), () => 1),
          )
        : [],
      Predicate.hasProperty(node, "children") ? Array.flatMap(node.children, walk) : [],
    );
  return walk(fromMarkdown(markdown));
};

const decodeSectionId = Schema.decodeUnknownOption(SectionId);

/**
 * Every heading of `markdown` outside a fence, in document order. A heading is what
 * `assignSectionIds` sees as one. `keys` and `human` come down the heading tree: a level-1
 * heading is the parent of the level-2 headings that follow it.
 */
export const sectionsOf = (markdown: string): readonly Section[] => {
  const lines = linesOf(markdown);
  const markers = markerLinesOf(markdown);
  const starts = Array.getSomes(
    Array.map(headingsOf(lines), (found, index) =>
      Option.map(found, (heading) => ({ heading, index })),
    ),
  );
  const ends = Array.append(
    Array.map(Array.drop(starts, 1), ({ index }) => index),
    lines.length,
  );

  return Array.mapAccum(
    Array.zip(starts, ends),
    Array.empty<Open>(),
    (stack, [{ heading, index }, end]) => {
      const above = Array.filter(stack, ({ level }) => level < heading.level);
      const parent = Array.last(above);
      const bodyLines = Array.take(Array.drop(lines, index + 1), end - index - 1);
      const own = ownKeysOf(keyEntriesOf(bodyLines));
      const keys = mergeKeys(
        Option.match(parent, { onNone: () => NO_KEYS, onSome: (open) => open.keys }),
        own,
      );
      const human =
        Array.some(markers, (line) => line > index + 1 && line <= end) ||
        Option.exists(parent, (open) => open.human);
      const id = Option.flatMap(heading.id, decodeSectionId);
      const section: Section = {
        body: Array.join(bodyLines, "\n"),
        human,
        id: Option.getOrUndefined(id),
        keys,
        level: heading.level,
        line: index + 1,
        parent: pipe(
          Array.findLast(above, (open) => Option.isSome(open.id)),
          Option.flatMap((open) => open.id),
          Option.getOrUndefined,
        ),
        title: heading.text,
      };
      return [Array.append(above, { human, id, keys, level: heading.level }), section];
    },
  )[1];
};
