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
  Option,
  Path,
  PlatformError,
  Schema,
  String,
  Struct,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ConfigJson, defaultConfig } from "@cairn/contract";

import {
  AlreadyInitialized,
  DEFAULT_CONFIG,
  IGNORED_LINE,
  init,
  withIgnoredLine,
} from "../src/commands/init.ts";
import { MainCheckout, NotARepository } from "../src/main-checkout.ts";

const directoryOf = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped();
});

const rootOf = Effect.gen(function* () {
  return yield* (yield* MainCheckout).root;
});

const initIn = (root: string) => init().pipe(Effect.provide(MainCheckout.fixed(root)));

const templateText = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const location = yield* path.fromFileUrl(new URL("../src/templates/prd.md", import.meta.url));
  return yield* fs.readFileString(location);
});

/** Every file under `root`, relative, with its contents. */
const snapshot = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(root, { recursive: true });
    return yield* Effect.forEach(Array.sort(names, String.Order), (name) =>
      fs.stat(path.join(root, name)).pipe(
        Effect.flatMap((info) =>
          info.type === "File"
            ? fs.readFileString(path.join(root, name))
            : Effect.succeed("<directory>"),
        ),
        Effect.map((content) => [name, content] as const),
      ),
    );
  });

const git = Effect.fn("git")(function* (directory: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const identity = Array.appendAll(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com"],
    args,
  );
  return yield* spawner.string(ChildProcess.make("git", identity, { cwd: directory }));
});

it.effect("init in an empty repository creates exactly the cairn files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* directoryOf;
      const template = yield* templateText;
      yield* initIn(root);
      const files = yield* snapshot(root);
      expect(files).toEqual([
        [".cairn", "<directory>"],
        [".cairn/config.json", DEFAULT_CONFIG],
        [".cairn/events.jsonl", ""],
        [".cairn/prd.md", template],
        [".gitignore", `${IGNORED_LINE}\n`],
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("the PRD template has an ID on every heading", () =>
  Effect.gen(function* () {
    const template = yield* templateText;
    const headings = Array.filter(String.split("\n")(template), String.startsWith("#"));
    expect(Array.isReadonlyArrayNonEmpty(headings)).toBe(true);
    expect(Array.every(headings, (line) => /\{#prd\.[a-z0-9.-]+\}$/u.test(line))).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "the default config lists the version and the default humanPaths, pretty-printed with a newline",
  () =>
    Effect.gen(function* () {
      expect(DEFAULT_CONFIG).toBe(
        '{\n  "version": 1,\n  "humanPaths": [\n    "**/migrations/**",\n    "**/migrate/**",\n    "**/auth/**",\n    "**/payments/**",\n    "infra/**",\n    ".github/workflows/**"\n  ]\n}\n',
      );
      const decoded = yield* Schema.decodeEffect(ConfigJson)(DEFAULT_CONFIG);
      expect(decoded).toEqual(defaultConfig);
    }),
);

const ignoredLines = (text: string) =>
  Array.length(
    Array.filter(String.split("\n")(text), (line) => String.trimEnd(line) === IGNORED_LINE),
  );

// The ignore line is added once, to whatever .gitignore holds, and what was there stays.
it.prop(
  "withIgnoredLine keeps the old text and lists the database once",
  [Schema.String],
  ([existing]) => {
    const after = withIgnoredLine(existing);
    expect(String.startsWith(existing)(after)).toBe(true);
    expect(ignoredLines(after)).toBe(ignoredLines(existing) === 0 ? 1 : ignoredLines(existing));
    expect(withIgnoredLine(after)).toBe(after);
  },
);

it.prop(
  "withIgnoredLine leaves a file that already lists the database as it is",
  [Schema.String, Schema.String],
  ([head, tail]) => {
    const existing = `${head}\n${IGNORED_LINE}  \n${tail}`;
    expect(withIgnoredLine(existing)).toBe(existing);
  },
);

const gitignoreAfterInit = (before: Option.Option<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* directoryOf;
      if (Option.isSome(before)) {
        yield* fs.writeFileString(path.join(root, ".gitignore"), before.value);
      }
      yield* initIn(root);
      return yield* fs.readFileString(path.join(root, ".gitignore"));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect(
  "init creates a missing .gitignore, appends to one without the line, keeps one with it",
  () =>
    Effect.gen(function* () {
      const created = yield* gitignoreAfterInit(Option.none());
      const appended = yield* gitignoreAfterInit(Option.some("node_modules"));
      const appendedAfterNewline = yield* gitignoreAfterInit(Option.some("dist/\n"));
      const listed = `dist/\n${IGNORED_LINE}\nout/\n`;
      const kept = yield* gitignoreAfterInit(Option.some(listed));
      expect(created).toBe(`${IGNORED_LINE}\n`);
      expect(appended).toBe(`node_modules\n${IGNORED_LINE}\n`);
      expect(appendedAfterNewline).toBe(`dist/\n${IGNORED_LINE}\n`);
      expect(kept).toBe(listed);
      // Leading spaces are part of a git pattern, so an indented line ignores nothing.
      const indented = yield* gitignoreAfterInit(Option.some(`  ${IGNORED_LINE}\n`));
      expect(indented).toBe(`  ${IGNORED_LINE}\n${IGNORED_LINE}\n`);
    }),
);

it.effect("init refuses an existing .cairn/, changes nothing and fails with a typed error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* directoryOf;
      yield* fs.makeDirectory(path.join(root, ".cairn"));
      yield* fs.writeFileString(path.join(root, ".cairn", "prd.md"), "mine\n");
      yield* fs.writeFileString(path.join(root, ".gitignore"), "node_modules\n");
      const before = yield* snapshot(root);
      const error = yield* Effect.flip(initIn(root));
      const after = yield* snapshot(root);
      expect(Schema.is(AlreadyInitialized)(error)).toBe(true);
      expect(after).toEqual(before);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

/** The real file system, whose write of `config.json`, the last file of the new `.cairn/`, does `instead`. */
const configWriteDoes = (
  instead: (
    disk: FileSystem.FileSystem,
    file: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const disk = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return Struct.assign(disk, {
        writeFileString: (file: string, data: string) =>
          path.basename(file) === "config.json"
            ? instead(disk, file)
            : disk.writeFileString(file, data),
      });
    }),
  );

it.effect("init that fails midway leaves no .cairn/ and nothing staged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* directoryOf;
      const refused = PlatformError.systemError({
        _tag: "PermissionDenied",
        method: "writeFileString",
        module: "FileSystem",
      });
      const exit = yield* Effect.exit(
        initIn(root).pipe(Effect.provide(configWriteDoes(() => Effect.fail(refused)))),
      );
      const left = yield* snapshot(root);
      // Nothing is left for the next init to refuse.
      yield* initIn(root);
      const again = yield* snapshot(root);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(left).toEqual([]);
      expect(Array.map(again, ([name]) => name)).toContain(".cairn/config.json");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("init that cannot read .gitignore fails before it makes .cairn/", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* directoryOf;
      const gitignore = path.join(root, ".gitignore");
      yield* fs.writeFileString(gitignore, "node_modules\n");
      yield* fs.chmod(gitignore, 0o000);
      const exit = yield* Effect.exit(initIn(root));
      const made = yield* fs.exists(path.join(root, ".cairn"));
      const names = yield* fs.readDirectory(root);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(made).toBe(false);
      expect(names).toEqual([".gitignore"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("init interrupted midway leaves no .cairn/ and nothing staged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* directoryOf;
      const started = yield* Deferred.make<void>();
      const stalling = configWriteDoes(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* Effect.forkChild(initIn(root).pipe(Effect.provide(stalling)));
      yield* Deferred.await(started);
      // prd.md and events.jsonl are written, but only in the staging directory.
      const during = yield* fs.exists(path.join(root, ".cairn"));
      yield* Fiber.interrupt(fiber);
      const after = yield* snapshot(root);
      expect(during).toBe(false);
      expect(after).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a .cairn/ made while init writes is kept with .gitignore, and init fails with AlreadyInitialized",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* directoryOf;
        const theirs = path.join(root, ".cairn", "prd.md");
        const gitignore = path.join(root, ".gitignore");
        const ignored = `node_modules\n${IGNORED_LINE}\n.env\n`;
        // Another init gets there first, after this one checked, and the person edits .gitignore since.
        const racing = configWriteDoes((disk, file) =>
          disk
            .makeDirectory(path.join(root, ".cairn"))
            .pipe(
              Effect.andThen(disk.writeFileString(theirs, "theirs\n")),
              Effect.andThen(disk.writeFileString(gitignore, ignored)),
              Effect.andThen(disk.writeFileString(file, DEFAULT_CONFIG)),
            ),
        );
        const error = yield* Effect.flip(initIn(root).pipe(Effect.provide(racing)));
        const text = yield* fs.readFileString(theirs);
        const names = yield* fs.readDirectory(path.join(root, ".cairn"));
        const ignoring = yield* fs.readFileString(gitignore);
        expect(Schema.is(AlreadyInitialized)(error)).toBe(true);
        expect(text).toBe("theirs\n");
        expect(names).toEqual(["prd.md"]);
        expect(ignoring).toBe(ignored);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

// One honest test of the lookup: a real repository with a linked worktree.
it.effect("the main checkout comes from git's common directory, not the worktree", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* directoryOf;
      const base = yield* fs.realPath(temporary);
      const main = path.join(base, "main");
      const linked = path.join(base, "linked");
      yield* fs.makeDirectory(main);
      yield* git(main, ["init", "--quiet"]);
      yield* git(main, ["commit", "--quiet", "--allow-empty", "-m", "First"]);
      yield* git(main, ["worktree", "add", "--quiet", "-b", "feature", linked]);
      const fromLinked = yield* rootOf.pipe(Effect.provide(MainCheckout.layer(linked)));
      expect(fromLinked).toBe(main);
      yield* init().pipe(Effect.provide(MainCheckout.layer(linked)));
      const inMain = yield* fs.exists(path.join(main, ".cairn", "prd.md"));
      const inLinked = yield* fs.exists(path.join(linked, ".cairn"));
      expect(inMain).toBe(true);
      expect(inLinked).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("outside a repository the lookup fails with NotARepository", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* directoryOf;
      const error = yield* Effect.flip(rootOf.pipe(Effect.provide(MainCheckout.layer(root))));
      expect(Schema.is(NotARepository)(error)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
