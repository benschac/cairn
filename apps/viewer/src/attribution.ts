import type { FileEdit, Session, ToolTurn, Turn } from "@cairn/contract";
import type { ChangeContent, ContextContent, FileDiffMetadata, Hunk } from "@pierre/diffs";
import { Array, HashMap, Option, Order, Record, String } from "effect";

/**
 * How much of a hunk the session wrote: every counted line, some of them, or none. A hunk with no
 * counted line, such as one that only adds blank lines, is untraced.
 */
export type Traced = "traced" | "partly" | "untraced";

/** A hunk: its file's path and its index among that file's hunks. */
export interface HunkKey {
  readonly path: string;
  readonly index: number;
}

/** A tool turn as a hunk's mark names it: its ID, its place in the session from 1, and its tool. */
export interface MarkTurn {
  readonly id: string;
  readonly number: number;
  readonly name: string;
}

/** The turns that wrote one hunk, in log order, and how much of it they wrote. */
export interface HunkAttribution extends HunkKey {
  readonly turns: ReadonlyArray<MarkTurn>;
  readonly traced: Traced;
}

/** Each hunk's turns, in the diff's order, and each turn's hunks, by turn ID. */
export interface Attribution {
  readonly hunks: ReadonlyArray<HunkAttribution>;
  readonly turns: Record.ReadonlyRecord<string, ReadonlyArray<HunkKey>>;
}

/** Which of an edit's line lists a diff line is looked up in. */
type Side = "added" | "removed";

/** A diff line without its line ending, as an edit holds it. */
const textOf = (line: string): string => String.replace(/\r?\n$/u, "")(line);

/** A blank line is not traced and does not count. */
const isCounted = (text: string): boolean => String.isNonEmpty(String.trim(text));

const isTool = (turn: Turn): turn is ToolTurn => turn.kind === "tool";

const isChange = (content: ChangeContent | ContextContent): content is ChangeContent =>
  content.type === "change";

/**
 * For one path, the place in the session of the last tool turn whose edit to it wrote each text
 * on that side. A later turn replaces an earlier one, so the text goes to the turn that wrote it
 * last.
 */
const writersOf = (
  turns: ReadonlyArray<Turn>,
  path: string,
  side: Side,
): HashMap.HashMap<string, number> =>
  Array.reduce(turns, HashMap.empty<string, number>(), (writers, turn, place) =>
    isTool(turn)
      ? Array.reduce(
          Array.flatMap(
            Array.filter(turn.edits, (edit: FileEdit) => edit.path === path),
            (edit: FileEdit) => edit[side],
          ),
          writers,
          (written, text) => HashMap.set(written, text, place),
        )
      : writers,
  );

/** The changed lines of a hunk on one side, without their line endings, in the hunk's order. */
const changedLinesOf = (file: FileDiffMetadata, hunk: Hunk, side: Side): ReadonlyArray<string> =>
  Array.flatMap(Array.filter(hunk.hunkContent, isChange), (change: ChangeContent) =>
    Array.map(
      side === "added"
        ? Array.take(Array.drop(file.additionLines, change.additionLineIndex), change.additions)
        : Array.take(Array.drop(file.deletionLines, change.deletionLineIndex), change.deletions),
      textOf,
    ),
  );

const tracedOf = (places: ReadonlyArray<Option.Option<number>>): Traced =>
  Array.every(places, Option.isSome)
    ? Array.isReadonlyArrayNonEmpty(places)
      ? "traced"
      : "untraced"
    : Array.some(places, Option.isSome)
      ? "partly"
      : "untraced";

/**
 * Which tool turns of the session wrote each hunk of the files, and which hunks each turn wrote.
 * Each changed line is traced to the last turn, in log order, with an edit to the same path whose
 * `added` (for an added line) or `removed` (for a removed line) holds exactly its text. Blank lines
 * are not traced and do not count. A hunk's turns are the distinct turns of its lines, in log order.
 */
export const attributionOf = (
  files: ReadonlyArray<FileDiffMetadata>,
  session: Session,
): Attribution => {
  const markOf = (place: number): Option.Option<MarkTurn> =>
    Option.map(Option.filter(Array.get(session.turns, place), isTool), (turn) => ({
      id: turn.id,
      name: turn.name,
      number: place + 1,
    }));
  const hunks = Array.flatMap(files, (file) => {
    const writers = {
      added: writersOf(session.turns, file.name, "added"),
      removed: writersOf(session.turns, file.name, "removed"),
    };
    const placesOn = (hunk: Hunk, side: Side): ReadonlyArray<Option.Option<number>> =>
      Array.map(Array.filter(changedLinesOf(file, hunk, side), isCounted), (text) =>
        HashMap.get(writers[side], text),
      );
    return Array.map(file.hunks, (hunk, index): HunkAttribution => {
      const places = Array.appendAll(placesOn(hunk, "removed"), placesOn(hunk, "added"));
      return {
        index,
        path: file.name,
        traced: tracedOf(places),
        turns: Array.getSomes(
          Array.map(Array.sort(Array.dedupe(Array.getSomes(places)), Order.Number), markOf),
        ),
      };
    });
  });
  return {
    hunks,
    turns: Record.map(
      Array.groupBy(
        Array.flatMap(hunks, (hunk) => Array.map(hunk.turns, (turn) => ({ hunk, id: turn.id }))),
        ({ id }) => id,
      ),
      (written) =>
        Array.map(written, ({ hunk }): HunkKey => ({ index: hunk.index, path: hunk.path })),
    ),
  };
};

/** Where a hunk's mark goes: its first changed line, a removed one when the hunk removes first. */
export interface MarkLine {
  readonly side: "additions" | "deletions";
  readonly lineNumber: number;
}

/** The first changed line of a hunk, or none for a hunk that changes nothing. */
export const markLineOf = (hunk: Hunk): Option.Option<MarkLine> =>
  Option.map(Array.findFirst(hunk.hunkContent, isChange), (change) =>
    change.deletions > 0
      ? {
          lineNumber: hunk.deletionStart + change.deletionLineIndex - hunk.deletionLineIndex,
          side: "deletions",
        }
      : {
          lineNumber: hunk.additionStart + change.additionLineIndex - hunk.additionLineIndex,
          side: "additions",
        },
  );
