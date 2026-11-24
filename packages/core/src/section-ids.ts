import type { SectionPrefix } from "@cairn/contract";
import { Array, HashSet, Option, String, pipe } from "effect";

const FENCE = /^\s*(?:```|~~~)/u;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/u;
const TRAILING_ID = /[ \t]*\{#([^}\s]+)\}$/u;

export interface Heading {
  readonly id: Option.Option<string>;
  readonly level: number;
  readonly text: string;
}

interface Ancestor {
  readonly id: string;
  readonly level: number;
}

interface Assigned {
  readonly added: readonly string[];
  readonly ancestors: readonly Ancestor[];
  readonly taken: HashSet.HashSet<string>;
}

const headingOf = (line: string): Option.Option<Heading> =>
  pipe(
    line,
    String.match(HEADING),
    Option.map(([, hashes = "", rest = ""]) => ({
      id: pipe(rest, String.match(TRAILING_ID), Option.flatMap(Array.get(1))),
      level: hashes.length,
      text: pipe(rest, String.replace(TRAILING_ID, "")),
    })),
  );

const slugOf = (text: string): string =>
  pipe(
    text,
    String.toLowerCase,
    String.replaceAll(/[^a-z0-9]+/gu, "-"),
    String.replaceAll(/^-|-$/gu, ""),
    Option.liftPredicate(String.isNonEmpty),
    Option.getOrElse(() => "section"),
  );

/** `base`, or the first of `base-2`, `base-3`, ... that is not taken. */
const unusedId = (taken: HashSet.HashSet<string>, base: string, copy = 1): string => {
  const id = copy === 1 ? base : `${base}-${copy}`;
  return HashSet.has(taken, id) ? unusedId(taken, base, copy + 1) : id;
};

/** A level-1 heading titles the document, so it never namespaces a section. */
const namespaceOf = (ancestors: readonly Ancestor[], prefix: SectionPrefix): string =>
  pipe(
    Array.findLast(ancestors, (ancestor) => ancestor.level >= 2),
    Option.map((ancestor) => ancestor.id),
    Option.getOrElse(() => prefix),
  );

/** Per line: is it a fence marker or inside a fenced block? Nothing there is a heading or a marker. */
export const fencedOf = (lines: readonly string[]): readonly boolean[] =>
  Array.mapAccum(lines, false, (fenced, line) =>
    FENCE.test(line) ? [!fenced, true] : [fenced, fenced],
  )[1];

/** Per line: the heading on it, if it is one outside a fence. */
export const headingsOf = (lines: readonly string[]): readonly Option.Option<Heading>[] =>
  Array.zipWith(lines, fencedOf(lines), (line, fenced) =>
    fenced ? Option.none() : headingOf(line),
  );

const idsOf = (headings: readonly Option.Option<Heading>[]): string[] =>
  Array.getSomes(
    Array.map(
      headings,
      Option.flatMap((heading) => heading.id),
    ),
  );

export const linesOf = String.split("\n");

export const assignSectionIds = (
  markdown: string,
  prefix: SectionPrefix,
): { readonly added: readonly string[]; readonly markdown: string } => {
  const lines = linesOf(markdown);
  const headings = headingsOf(lines);
  const initial: Assigned = {
    added: [],
    ancestors: [],
    taken: HashSet.fromIterable(idsOf(headings)),
  };

  const assign = (
    state: Assigned,
    line: string,
    found: Option.Option<Heading>,
  ): [Assigned, string] => {
    if (Option.isNone(found)) {
      return [state, line];
    }
    const { id: existing, level, text } = found.value;
    const ancestors = Array.filter(state.ancestors, (above) => above.level < level);
    if (Option.isSome(existing)) {
      const id = existing.value;
      return [{ ...state, ancestors: Array.append(ancestors, { id, level }) }, line];
    }
    const id = unusedId(state.taken, `${namespaceOf(ancestors, prefix)}.${slugOf(text)}`);
    const next: Assigned = {
      added: Array.append(state.added, id),
      ancestors: Array.append(ancestors, { id, level }),
      taken: HashSet.add(state.taken, id),
    };
    return [next, `${String.repeat(level)("#")} ${text} {#${id}}`];
  };

  const [{ added }, result] = Array.mapAccum(
    Array.zip(lines, headings),
    initial,
    (state, [line, found]) => assign(state, line, found),
  );
  return { added, markdown: Array.join(result, "\n") };
};

export const sectionIdsOf = (markdown: string): readonly string[] =>
  idsOf(headingsOf(linesOf(markdown)));
