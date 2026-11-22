// Markdown helpers shared by the scripts that index agent sources.

import { Array, Option, String } from "effect";

export interface Heading {
  readonly name: string;
  // The 1-based line the heading is on.
  readonly start: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^#{1,6} (.+?)\r?$/;

// A table cell that keeps its pipes.
export const escapeCell: (text: string) => string = String.replaceAll("|", "\\|");

// A fence line closes the open fence when it repeats the opening character at least as many times and has no info string.
const closes = (open: string, run: string, info: string) =>
  run[0] === open[0] && run.length >= open.length && String.isEmpty(String.trim(info));

// Markdown headings outside fenced code, threading the open fence (if any) from line to line.
export const headingsOf = (lines: ReadonlyArray<string>): ReadonlyArray<Heading> => {
  const [, found] = Array.mapAccum(
    lines,
    Option.none<string>(),
    (fence, line, i): readonly [Option.Option<string>, Option.Option<Heading>] => {
      const marker = FENCE.exec(line);
      if (marker) {
        const [, run = "", info = ""] = marker;
        const next = Option.match(fence, {
          onNone: () => Option.some(run),
          onSome: (open) => (closes(open, run, info) ? Option.none() : fence),
        });
        return [next, Option.none()];
      }
      const heading = Option.isNone(fence)
        ? Option.map(Option.fromNullishOr(HEADING.exec(line)?.[1]), (name) => ({
            name,
            start: i + 1,
          }))
        : Option.none();
      return [fence, heading];
    },
  );
  return Array.getSomes(found);
};

// A "Topic | Start line | End line" table over a document of `lineCount` lines: each topic ends where the next begins.
export const topicTable = (topics: ReadonlyArray<Heading>, lineCount: number) => [
  "| Topic | Start line | End line |",
  "| --- | ---: | ---: |",
  ...Array.map(topics, (topic, i) => {
    const end = Option.match(Array.get(topics, i + 1), {
      onNone: () => lineCount,
      onSome: (next) => next.start - 1,
    });
    return `| ${escapeCell(topic.name)} | ${topic.start} | ${end} |`;
  }),
];
