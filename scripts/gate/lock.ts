// One `pnpm check` at a time on this machine. Several worktrees running it at once each start turbo over every
// package, and the load slows every test past its timeout. Every worktree shares git's common directory, so a
// lock file there is seen by each check: a check takes it before it starts and gives it back when it ends,
// whether it passed, failed or was interrupted, and a check that finds it taken waits, saying whose it is.
// A check killed before it could give the lock back leaves a holder whose process is gone; the next check
// clears it.

import { Clock, Effect, FileSystem, Option, Predicate, Ref, Schedule, Schema } from "effect";

/** The lock file in git's common directory, beside the record of checked commits. */
export const LOCK_FILE = "cairn-check.lock";

/** Who holds the lock: the gate's process, the worktree it checks, and when it took the lock. */
export const Holder = Schema.Struct({
  pid: Schema.Int,
  since: Schema.String,
  worktree: Schema.String,
});
export type Holder = typeof Holder.Type;

const HolderJson = Schema.fromJsonString(Holder);
const encodeHolder = Schema.encodeSync(HolderJson);
const decodeHolder = Schema.decodeUnknownOption(HolderJson);

/** How often a waiting check looks at the lock again. */
const POLL = "1 second";

/** What a waiting check says, once for each holder it waits for. */
export const waitingMessage = (holder: Holder): string =>
  `Waiting for the pnpm check in ${holder.worktree} (pid ${holder.pid}, since ${holder.since}) to finish: one check runs at a time on this machine.`;

// Signal 0 checks that a process exists without touching it; EPERM means it exists under another user.
const isRunning = (pid: number) =>
  Effect.try({
    catch: (error) => Predicate.hasProperty(error, "code") && error.code === "EPERM",
    try: () => process.kill(pid, 0),
  }).pipe(Effect.match({ onFailure: (isAnotherUsers) => isAnotherUsers, onSuccess: () => true }));

/** The lock's text, or none when no check holds it. */
const readLock = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );
});

/**
 * Takes the lock if no check holds it. The holder is written to a file of this process's own first and
 * linked into place, so the lock never exists without its holder in it, and the link fails if the lock does.
 */
const tryTake = Effect.fnUntraced(function* (file: string, mine: string) {
  const fs = yield* FileSystem.FileSystem;
  const draft = `${file}.${process.pid}`;
  yield* fs.writeFileString(draft, mine);
  return yield* fs.link(draft, file).pipe(
    Effect.as(true),
    Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
    Effect.ensuring(Effect.ignore(fs.remove(draft))),
  );
});

/** How long a check may hold the guard while it clears a stale lock before the guard counts as left behind. */
const GUARD_STALE_MS = 10_000;

/** Removes a file older than `ms`; a file that is gone is left gone. */
const removeIfOlder = Effect.fnUntraced(function* (path: string, ms: number) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const info = yield* fs.stat(path).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );
  const isOld = Option.exists(
    Option.flatMap(info, (found) => found.mtime),
    (mtime) => now - mtime.getTime() > ms,
  );
  if (isOld) {
    yield* Effect.ignore(fs.remove(path));
  }
});

/**
 * Clears a lock whose holder is gone, and says whether it did. Only the check holding the guard, a second lock
 * beside it, may clear one. While a lock is there no check can take it, and the guard keeps a second clearer
 * away, so a lock that still holds the gone holder under the guard can be removed: a live holder's lock is
 * never moved or removed. A guard is held for a moment; one older than ten seconds was left by a check killed
 * while it cleared, and is removed so the next look can clear.
 */
const clearStale = Effect.fnUntraced(function* (file: string, seen: string, mine: string) {
  const fs = yield* FileSystem.FileSystem;
  const guard = `${file}.clearing`;
  const guarded = yield* tryTake(guard, mine);
  if (!guarded) {
    yield* removeIfOlder(guard, GUARD_STALE_MS);
    return false;
  }
  return yield* Effect.gen(function* () {
    const current = yield* readLock(file);
    if (!Option.contains(current, seen)) return false;
    yield* fs.remove(file);
    return true;
  }).pipe(Effect.ensuring(release(guard, mine)));
});

/** Waits until this check holds the lock, clearing a stale holder and saying whose check it waits for. */
const take = Effect.fnUntraced(function* (file: string, mine: string) {
  const reported = yield* Ref.make(Option.none<string>());
  const attempt = Effect.gen(function* () {
    if (yield* tryTake(file, mine)) return true;
    const seen = yield* readLock(file);
    // Given back between the two reads: try again.
    if (Option.isNone(seen)) return false;
    const holder = decodeHolder(seen.value);
    const running = yield* Option.match(holder, {
      // The gate always writes a holder, so a lock without one was not left by a check.
      onNone: () => Effect.succeed(false),
      onSome: (found) => isRunning(found.pid),
    });
    if (!running) {
      const cleared = yield* clearStale(file, seen.value, mine);
      if (!cleared) return false;
      yield* Effect.logWarning(
        `Cleared the check lock left by ${Option.match(holder, { onNone: () => "a file that names no check", onSome: (found) => `pid ${found.pid}, which is no longer running` })}.`,
      );
      return false;
    }
    const last = yield* Ref.get(reported);
    if (!Option.contains(last, seen.value)) {
      yield* Ref.set(reported, seen);
      yield* Option.match(holder, {
        onNone: () => Effect.void,
        onSome: (found) => Effect.logInfo(waitingMessage(found)),
      });
    }
    return false;
  });
  yield* Effect.repeat(attempt, { schedule: Schedule.spaced(POLL), until: (taken) => taken });
  const waited = yield* Ref.get(reported);
  if (Option.isSome(waited)) {
    yield* Effect.logInfo("The other check finished; this one starts now.");
  }
});

/** Gives the lock back, if it is still this check's. */
const release = (file: string, mine: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* readLock(file);
    if (Option.contains(text, mine)) {
      yield* fs.remove(file);
    }
  }).pipe(Effect.ignore);

/**
 * Holds the check lock in `file` for the rest of the scope, as `holder`, waiting while another check has it.
 * The release is in place before the wait, so the wait stays interruptible (Ctrl-C while waiting ends the
 * check) and a lock taken just before an interrupt is still given back. It removes only this check's own lock.
 */
export const holdCheckLock = (file: string, holder: Holder) => {
  const mine = encodeHolder(holder);
  return Effect.andThen(
    Effect.addFinalizer(() => release(file, mine)),
    take(file, mine),
  );
};
