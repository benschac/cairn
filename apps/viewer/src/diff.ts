import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { Array, Option, Result, Schema, String } from "effect";

/** The patch text could not be read by `@pierre/diffs`. */
export class PatchNotParsed extends Schema.TaggedError<PatchNotParsed>()("PatchNotParsed", {
  cause: Schema.Defect(),
}) {}

/** What a patch holds: the commit message `git show` leads with, and one entry per changed file. */
export interface PatchFiles {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  /** The commit's header and message; none for a `git diff` patch. */
  readonly maybeMessage: Option.Option<string>;
}

/**
 * The files of a patch: `git show --patch` output for one commit, or `git diff --patch` output
 * for a range. The library reads the hunks; Cairn only collects what it returns.
 */
export const parsePatch = (text: string): Result.Result<PatchFiles, PatchNotParsed> =>
  Result.map(
    Result.try({
      catch: (cause) => new PatchNotParsed({ cause }),
      try: () => parsePatchFiles(text),
    }),
    (patches) => ({
      files: Array.flatMap(patches, (patch) => patch.files),
      maybeMessage: Option.filter(
        Option.flatMap(Array.head(patches), (patch) => Option.fromUndefinedOr(patch.patchMetadata)),
        String.isNonEmpty,
      ),
    }),
  );

/** The sentence the viewer shows for a patch that did not parse. */
export const describePatchNotParsed = ({ cause }: PatchNotParsed): string =>
  `The patch did not parse: ${globalThis.String(cause)}`;
