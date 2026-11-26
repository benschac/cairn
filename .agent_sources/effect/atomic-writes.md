# Atomic writes

Write somewhere private, then publish with one atomic file-system call. A plain `writeFileString` truncates
its target and then fills it, so a reader (`cairn serve`, another worktree's command, a file watcher) can
decode it half written, and a crash leaves it truncated. `exists` followed by a write lets two writers both
pass the check. From Harry Solovay's talk [Advanced Effect Design Patterns](https://youtu.be/_tSGby_q890?t=1366)
at Effect Miami 3, chapter "Atomic writes", from 22:46.

> Stage the file beside its target, then `rename` it into place to replace or `link` it to create.

Line numbers are for the installed `effect`. If one has moved, find the export again with
`rg -n '^export declare' <file>` or `rg -n 'readonly <name>' node_modules/effect/dist/FileSystem.d.ts`.

## The helper

`packages/cli/src/atomic-write.ts` does it; call it rather than writing the steps again. It imports only from
`effect`, so a script under `scripts/` can import it by relative path.

| Need | Call | What it does |
| --- | --- | --- |
| Replace a file or create it: a reader sees the old contents or the new, never a mix | `replaceFile(target, contents)` | Stages `contents` in a directory beside `target`, copies an existing file's mode onto it, and `rename`s it over `target` |
| Create a file only if nothing is there: a lock, a record two writers race for | `createFile(target, contents)` | Stages `contents` the same way and `link`s it to `target`; fails with `FileAlreadyExists` (with the path) and leaves an existing file untouched |

Both are `Effect.fn`s needing `FileSystem | Path` and close their own scope. `cairn init` builds a whole
directory the same way: it stages `.cairn/` in the repository root and renames the directory into place
(`packages/cli/src/commands/init.ts`). `scripts/gate/lock.ts` (`tryTake`) is the create half written by hand.

The scripts under `scripts/` replace their generated files with it too: the record of checked commits
(`scripts/gate/gate.ts`), `demo-trace.json` and the `.agent_sources` indexes and `sources.json`. The one
write left plain is `refresh-pattern-sources`' cached document, which `replaceFile` cannot take: it writes
the downloaded bytes unchanged, so that their `sha256` stays the one `sources.json` records.

## The API underneath

| Step | Export | Declaration |
| --- | --- | --- |
| A private directory beside the target, removed with what is in it when the scope closes | `fs.makeTempDirectoryScoped({ directory: path.dirname(target), prefix: ".write-" })` inside `Effect.scoped` | `node_modules/effect/dist/FileSystem.d.ts` 162-172 |
| Keep the old file's permissions | `fs.stat(target)` (`NotFound` is a new file), then `fs.chmod(staged, info.mode & 0o7777)` | `FileSystem.d.ts` 89, 282 |
| Publish, replacing | `fs.rename(staged, target)` | `FileSystem.d.ts` 268-271 |
| Publish only if absent | `fs.link(staged, target)` with `Effect.catchReason("PlatformError", "AlreadyExists", ...)` | `FileSystem.d.ts` 131; `Effect.d.ts` `catchReason` 4837 |

## Replace or create

- `replaceFile` for a file Cairn owns and rewrites: `manifest.json`, `spec.md`, `spec.json`,
  `judgments.json`, the person's `prd.md` after `cairn ids` or an answer in `cairn plan`, `.gitignore`.
- `createFile` where finding the file already there means someone else got there first, and the caller has
  to know: a lock, a claim, a record that must not be overwritten.
- Neither for an append-only log. `events.jsonl` is appended one whole line per write with `{ flag: "a" }`:
  replacing it would drop a line another writer appended between the read and the rename.

## Traps

- Stage in the target's own directory. `rename` and `link` work only within one file system, and the
  default temporary directory is often on another (`EXDEV`).
- The scope removes the staging directory on success, failure and interruption, not on `SIGKILL` or a power
  cut, which leave a `.write-*` directory behind. The `.` prefix keeps it out of a plain listing; it still
  shows in `git status`.
- It survives a crashed process, not a power cut: nothing calls `fsync` on the file or its directory.
- It makes one file atomic. Several files written in a row (the manifest, then `spec.md`, `spec.json`,
  `judgments.json`) are each whole, but a reader can see some new and some old.
- `rename` replaces the target's inode. A watcher on the file itself stops hearing about it after the first
  write; watch the directory. A symbolic link at the target is replaced by a regular file.
- A rename of a directory onto a directory that is not empty fails with `ENOTEMPTY`, which
  `@effect/platform-node-shared` reports as reason `Unknown` (only `EEXIST` is `AlreadyExists`), and onto an
  empty directory it succeeds and replaces it. So `cairn init` keeps its `exists` check up front, and reads a
  failed rename with the directory now there as `AlreadyInitialized`.
- When one operation claims the work with one call and writes a shared file too, write the shared file after
  the claim succeeds. `cairn init` writes `.gitignore` after the rename of `.cairn/`: written before it, an
  init that lost a race would replace the `.gitignore` the winner, or the person since, left.
- A file system service that keeps writes in memory has to cover the staging calls too, or it writes to disk.
  `cairn plan --dry-run`'s `inMemory` layer (`packages/cli/src/commands/plan.ts`) names a staging directory
  without making it, keeps `chmod` on a staged file as a no-op, and moves what the run wrote on `rename` and
  `link`; asked to move a file it did not write, it dies rather than touch the disk.
- `Schema.String` generates unpaired surrogates, which UTF-8 cannot hold, so a file does not read back what
  was written. Generate contents with `String.isWellFormed` as a filter.

## Tests

`packages/cli/test/atomic-write.test.ts` runs on the real file system in `makeTempDirectoryScoped` and lists
the directory after each write, so a staging directory left behind fails it:

- A property over contents and modes: the new contents, the old mode, nothing else in the directory.
- A file system whose `writeFileString` fails, and one whose `writeFileString` writes a byte and never
  returns, interrupted with `Fiber.interrupt` once a `Deferred` says it started: the old file stays and no
  staging directory remains.
- A property for `createFile`: the second call fails with `FileAlreadyExists` and the first contents stay.

Build the failing file system from the real one with `Struct.assign(disk, { writeFileString })` inside
`Layer.effect(FileSystem.FileSystem, ...)`. `packages/cli/test/init.test.ts` does the same for `init` failing,
interrupted, or racing another `.cairn/`, and `packages/cli/test/plan-dry-run.test.ts` checks that a dry run
leaves the listing under the root and every file's bytes as they were.
