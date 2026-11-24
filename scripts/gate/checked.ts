// Pure helpers for scripts/gate/gate.ts: the commits a push sends and the record of commits `pnpm check` passed on.

import { Array, pipe, String } from "effect";

// The file in git's common directory, shared by every worktree, that lists checked commits one per line.
export const RECORD_FILE = "cairn-checked";
// How many of the latest checked commits the record keeps.
export const RECORD_LIMIT = 200;

const isZero = (sha: string) => /^0+$/u.test(sha);

const linesOf = (text: string) =>
  Array.filter(Array.map(String.split(text, "\n"), String.trim), String.isNonEmpty);

// The local commits a push sends, read from the lines git gives a pre-push hook:
// "<local ref> <local sha> <remote ref> <remote sha>". A deletion sends the all-zero sha, which is dropped.
export const pushedCommits = (input: string): Array<string> =>
  pipe(
    linesOf(input),
    Array.map((line) => Array.get(String.split(line, " "), 1)),
    Array.getSomes,
    Array.filter((sha) => !isZero(sha)),
    Array.dedupe,
  );

// The record with `sha` added as the latest checked commit, keeping at most RECORD_LIMIT commits.
export const appendRecord = (record: string, sha: string): string =>
  pipe(
    linesOf(record),
    Array.filter((line) => line !== sha),
    Array.append(sha),
    Array.takeRight(RECORD_LIMIT),
    Array.join("\n"),
    String.concat("\n"),
  );

// The checked commits in a record, latest first.
export const recordedCommits = (record: string): Array<string> => Array.reverse(linesOf(record));
