import type { SectionPrefix } from "@cairn/contract";

const FENCE = /^\s*(?:```|~~~)/u;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/u;
const TRAILING_ID = /[ \t]*\{#([^}\s]+)\}$/u;

interface Line {
  readonly id: string | undefined;
  readonly level: number;
  readonly text: string;
}

const headingOf = (line: string): Line | undefined => {
  const heading = HEADING.exec(line);
  if (heading === null) {
    return undefined;
  }
  const [, hashes = "", rest = ""] = heading;
  const id = TRAILING_ID.exec(rest);
  return {
    id: id?.[1],
    level: hashes.length,
    text: id === null ? rest : rest.slice(0, id.index),
  };
};

const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "") || "section";

const headingsOf = (lines: readonly string[]) => {
  let fenced = false;
  return lines.map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return undefined;
    }
    return fenced ? undefined : headingOf(line);
  });
};

export const assignSectionIds = (
  markdown: string,
  prefix: SectionPrefix,
): { readonly added: readonly string[]; readonly markdown: string } => {
  const lines = markdown.split("\n");
  const headings = headingsOf(lines);
  const taken = new Set(headings.flatMap((heading) => heading?.id ?? []));
  const added: string[] = [];
  const parents: (string | undefined)[] = [];

  const result = lines.map((line, index) => {
    const heading = headings[index];
    if (heading === undefined) {
      return line;
    }
    parents.length = heading.level;
    const parent = parents.slice(2).findLast((id) => id !== undefined);
    let id = heading.id;
    if (id === undefined) {
      const base = `${parent ?? prefix}.${slugOf(heading.text)}`;
      id = base;
      for (let copy = 2; taken.has(id); copy += 1) {
        id = `${base}-${copy}`;
      }
      taken.add(id);
      added.push(id);
    }
    parents[heading.level] = id;
    return heading.id === undefined
      ? `${"#".repeat(heading.level)} ${heading.text} {#${id}}`
      : line;
  });

  return { added, markdown: result.join("\n") };
};

export const sectionIdsOf = (markdown: string): readonly string[] =>
  headingsOf(markdown.split("\n")).flatMap((heading) => heading?.id ?? []);
