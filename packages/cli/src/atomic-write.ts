// Writes that a reader never sees half done. A plain `writeFileString` truncates its target and then fills it,
// so a reader or a file watcher can decode it half written, and a crash leaves it truncated. These write the
// file somewhere private first and then publish it with one atomic call: `rename` to replace, `link` to
// create only if absent. The staging directory sits beside the target, since neither call works across file
// systems, and the scope removes it however the write ends. See .agent_sources/effect/atomic-writes.md.
//
// A script under scripts/ imports this file by relative path, so it imports only from "effect".

import { Effect, FileSystem, Option, Path, Schema } from "effect";

/** `createFile` found `path` already there and left it as it was. */
export class FileAlreadyExists extends Schema.TaggedError<
  FileAlreadyExists,
  { readonly brand: unique symbol }
>()("FileAlreadyExists", { path: Schema.String }) {
  override get message() {
    return `${this.path} already exists`;
  }
}

/** The permission bits of a mode, without the file type. */
const PERMISSIONS = 0o7777;

/**
 * `contents` written to a file of the target's name in a new directory beside `target`, which the scope
 * removes with whatever is left in it.
 */
const staged = Effect.fnUntraced(function* (target: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: path.dirname(target),
    prefix: ".write-",
  });
  const file = path.join(directory, path.basename(target));
  yield* fs.writeFileString(file, contents);
  return file;
});

/**
 * Replaces `target` with `contents`, or creates it. A reader sees the old contents or the new ones, never a
 * mix, and a failed or interrupted write leaves the old file. An existing file keeps its mode.
 */
export const replaceFile = Effect.fn("replaceFile")(function* (target: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* staged(target, contents);
  const existing = yield* fs.stat(target).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );
  yield* Option.match(existing, {
    onNone: () => Effect.void,
    onSome: (info) => fs.chmod(file, info.mode & PERMISSIONS),
  });
  yield* fs.rename(file, target);
}, Effect.scoped);

/**
 * Creates `target` with `contents` only if nothing is there, failing with `FileAlreadyExists` and leaving an
 * existing file untouched. Two writers racing for one path cannot both succeed.
 */
export const createFile = Effect.fn("createFile")(function* (target: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* staged(target, contents);
  yield* fs
    .link(file, target)
    .pipe(
      Effect.catchReason("PlatformError", "AlreadyExists", () =>
        Effect.fail(new FileAlreadyExists({ path: target })),
      ),
    );
}, Effect.scoped);
