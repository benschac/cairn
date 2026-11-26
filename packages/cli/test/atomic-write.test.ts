import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Schema,
  String,
  Struct,
} from "effect";

import { createFile, FileAlreadyExists, replaceFile } from "../src/atomic-write.ts";

/** The permission bits of a mode. */
const PERMISSIONS = 0o7777;

/** Text a file holds as it was written: UTF-8 cannot hold an unpaired surrogate. */
const Text = Schema.String.pipe(Schema.check(Schema.makeFilter<string>(String.isWellFormed)));

/** Modes a file in a repository has; each leaves the owner able to read and write it. */
const Mode = Schema.Literals([0o600, 0o640, 0o644, 0o664, 0o700, 0o755]);

const inTemp = <A, E>(
  body: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    return yield* body(directory);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Everything in `directory`, sorted: a staging directory left behind shows here. */
const listing = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.map(fs.readDirectory(directory), (names) =>
      Array.sort(names, String.Order),
    );
  });

const refused = PlatformError.systemError({
  _tag: "PermissionDenied",
  method: "writeFileString",
  module: "FileSystem",
});

/** The real file system, with `writeFileString` replaced. */
const writingWith = (
  writeFileString: (
    disk: FileSystem.FileSystem,
  ) => (path: string, data: string) => Effect.Effect<void, PlatformError.PlatformError>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (disk) =>
      Struct.assign(disk, { writeFileString: writeFileString(disk) }),
    ),
  );

it.effect.prop(
  "replaceFile leaves the new contents, the old file's mode and nothing else",
  [Text, Text, Mode],
  ([before, after, mode]) =>
    inTemp((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = path.join(directory, "manifest.json");
        yield* fs.writeFileString(target, before);
        yield* fs.chmod(target, mode);
        yield* replaceFile(target, after);
        const info = yield* fs.stat(target);
        const text = yield* fs.readFileString(target);
        const names = yield* listing(directory);
        expect(text).toBe(after);
        expect(info.mode & PERMISSIONS).toBe(mode);
        expect(names).toEqual(["manifest.json"]);
      }),
    ),
  { arbitrary: { runs: 25 } },
);

it.effect("replaceFile creates a file that is not there", () =>
  inTemp((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = path.join(directory, "spec.json");
      yield* replaceFile(target, "{}\n");
      const text = yield* fs.readFileString(target);
      const names = yield* listing(directory);
      expect(text).toBe("{}\n");
      expect(names).toEqual(["spec.json"]);
    }),
  ),
);

it.effect("a write that fails leaves the old file and no staging directory", () =>
  inTemp((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = path.join(directory, "prd.md");
      yield* fs.writeFileString(target, "# Old\n");
      const exit = yield* Effect.exit(
        replaceFile(target, "# New\n").pipe(
          Effect.provide(writingWith(() => () => Effect.fail(refused))),
        ),
      );
      const text = yield* fs.readFileString(target);
      const names = yield* listing(directory);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(text).toBe("# Old\n");
      expect(names).toEqual(["prd.md"]);
    }),
  ),
);

it.effect("a write interrupted halfway leaves the old file and no staging directory", () =>
  inTemp((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = path.join(directory, "prd.md");
      yield* fs.writeFileString(target, "# Old\n");
      const started = yield* Deferred.make<void>();
      // The staged file is half written when the write stalls.
      const stalling = writingWith(
        (disk) => (file, data) =>
          disk
            .writeFileString(file, String.slice(0, 1)(data))
            .pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
            ),
      );
      const fiber = yield* Effect.forkChild(
        replaceFile(target, "# New\n").pipe(Effect.provide(stalling)),
      );
      yield* Deferred.await(started);
      // The target and the staging directory beside it.
      const during = yield* listing(directory);
      yield* Fiber.interrupt(fiber);
      const text = yield* fs.readFileString(target);
      const after = yield* listing(directory);
      expect(Array.length(during)).toBe(2);
      expect(text).toBe("# Old\n");
      expect(after).toEqual(["prd.md"]);
    }),
  ),
);

it.effect.prop(
  "createFile writes a file that is not there and refuses one that is, leaving its bytes",
  [Text, Text],
  ([first, second]) =>
    inTemp((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = path.join(directory, "cairn-check.lock");
        yield* createFile(target, first);
        const error = yield* Effect.flip(createFile(target, second));
        const text = yield* fs.readFileString(target);
        const names = yield* listing(directory);
        expect(error).toEqual(new FileAlreadyExists({ path: target }));
        expect(text).toBe(first);
        expect(names).toEqual(["cairn-check.lock"]);
      }),
    ),
  { arbitrary: { runs: 25 } },
);
