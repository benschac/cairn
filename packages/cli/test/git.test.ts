import { Manifest, SessionId, Sha, SpecSectionId, TaskId } from "@cairn/contract";
import type { GitCommit } from "@cairn/core";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Array,
  Context,
  Effect,
  FileSystem,
  HashMap,
  HashSet,
  Layer,
  Match,
  Option,
  Order,
  Path,
  Ref,
  Schema,
  Stream,
  String,
  Struct,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as GitLive from "../src/git-live.ts";
import { Git, GitError, GitHistory, mergeSubject } from "../src/git.ts";
import type { Authored } from "../src/git.ts";

const SESSION = SessionId.make("s_abc123");
const SECTION = SpecSectionId.make("spec.status.derivation");
const TASKS = ["t1", "t2"] as const;
type Task = (typeof TASKS)[number];
const branchOf = (task: string) => `cairn-mvp/00-${task}`;

/** Two stacked tasks, t2 on t1, and t3, which never gets a branch. */
const manifest = Schema.decodeSync(Manifest)({
  baseBranch: "main",
  feature: "cairn-mvp",
  tasks: Array.map(
    Array.make({ id: "t1", parent: null }, { id: "t2", parent: "t1" }, { id: "t3", parent: null }),
    ({ id, parent }) => ({
      branch: branchOf(id),
      commits: [],
      dependsOn: [],
      files: [],
      humanGate: { reasons: [], required: false },
      id,
      model: "sonnet",
      parent,
      prdSections: ["prd.orchestrator-contract"],
      reasoning: "low",
      sessions: [],
      specSections: [SECTION],
      status: "pending",
      title: id,
      worktree: null,
    }),
  ),
  version: 1,
});

/** Runs git and returns its stdout. A non-zero exit is a defect: the test wrote the command. */
const git = Effect.fn("git")(function* (directory: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: directory }));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return exitCode === 0
        ? String.trim(stdout)
        : yield* Effect.die(`git ${Array.join(args, " ")} exited ${exitCode}: ${stderr}`);
    }),
  ).pipe(Effect.orDie);
});

/** The commit message an orchestrator writes: the subject, then whichever trailers it has. */
const messageOf = (authored: Omit<Authored, "files">) =>
  Array.join(
    Array.appendAll(
      [authored.subject],
      Array.match(
        Array.flatten([
          Array.map(
            Option.toArray(Option.fromNullOr(authored.taskId)),
            (id) => `Cairn-Task: ${id}`,
          ),
          Array.map(authored.sections, (section) => `Cairn-Section: ${section}`),
          Array.map(
            Option.toArray(Option.fromNullOr(authored.session)),
            (id) => `Cairn-Session: ${id}`,
          ),
        ]),
        { onEmpty: () => [], onNonEmpty: (lines) => ["", Array.join(lines, "\n")] },
      ),
    ),
    "\n",
  );

class Directory extends Context.Service<Directory, string>()("test/Directory") {}

/** A temporary repository with one empty commit on `main`. */
const TempRepository = Layer.effect(
  Directory,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* Effect.forEach(
      [
        ["init", "--quiet", "--initial-branch=main"],
        ["config", "user.name", "Test"],
        ["config", "user.email", "test@example.com"],
        ["config", "commit.gpgsign", "false"],
        ["commit", "--quiet", "--allow-empty", "-m", "Initial commit"],
      ],
      (args) => git(directory, args),
      { discard: true },
    );
    return directory;
  }),
);

/**
 * `GitHistory` done by git: what `Git.memory` keeps, made in the temporary repository. Each commit
 * writes its subject into its files, so it changes every file it names.
 */
const GitWrites = Layer.effect(
  GitHistory,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* Directory;
    const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
    const run = (...args: ReadonlyArray<string>) =>
      git(directory, args).pipe(Effect.provideContext(services));
    const head = Effect.map(run("rev-parse", "HEAD"), (sha) => Sha.make(sha));
    const write = (file: string, content: string) =>
      Effect.andThen(
        fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true }),
        fs.writeFileString(path.join(directory, file), content),
      ).pipe(Effect.orDie);
    return GitHistory.of({
      branch: (name, from) => Effect.asVoid(run("branch", name, from)),
      commit: (branch, authored) =>
        Effect.gen(function* () {
          yield* run("switch", "--quiet", branch);
          yield* Effect.forEach(authored.files, (file) => write(file, `${authored.subject}\n`), {
            discard: true,
          });
          yield* run("add", "--all");
          yield* run("commit", "--quiet", "--allow-empty", "-m", messageOf(authored));
          return yield* head;
        }),
      merge: (branch, into) =>
        Effect.gen(function* () {
          yield* run("switch", "--quiet", into);
          yield* run("merge", "--quiet", "-X", "theirs", "-m", mergeSubject(branch), branch);
          return yield* head;
        }),
      squash: (branch, into, authored) =>
        Effect.gen(function* () {
          yield* run("switch", "--quiet", into);
          yield* run("merge", "--quiet", "--squash", "-X", "theirs", branch);
          yield* run("commit", "--quiet", "--allow-empty", "-m", messageOf(authored));
          return yield* head;
        }),
    });
  }),
);

const LiveGit = Layer.unwrap(
  Effect.gen(function* () {
    const directory = yield* Directory;
    return GitLive.layer(directory);
  }),
);

/** The live `Git` layer and git's own writes, over one temporary repository. */
const live = Layer.merge(GitWrites, LiveGit).pipe(
  Layer.provide(TempRepository),
  Layer.provideMerge(NodeServices.layer),
);

const trailers = (task: Task, subject: string): Omit<Authored, "files"> => ({
  sections: [SECTION],
  session: SESSION,
  subject,
  taskId: TaskId.make(task),
});

const Op = Schema.Union([
  Schema.TaggedStruct("Commit", {
    files: Schema.Array(Schema.Literals(["a.txt", "src/b.ts", "db/migrations/café 1.sql"])),
    task: Schema.Literals(TASKS),
    trailered: Schema.Boolean,
  }),
  Schema.TaggedStruct("Merge", { task: Schema.Literals(TASKS) }),
  Schema.TaggedStruct("Squash", { task: Schema.Literals(TASKS) }),
]);
type Op = typeof Op.Type;

/** A commit with every sha replaced by the subject of the commit it names, so two repositories compare. */
interface Named extends Omit<GitCommit, "parents" | "sha"> {
  readonly parents: ReadonlyArray<string>;
}

/**
 * Plays `ops` as an orchestrator would: a task's branch starts at its parent's head the first time
 * the task does anything. Returns what `Git.log` reads afterwards, by subject, sorted.
 */
const play = Effect.fn("play")(function* (ops: ReadonlyArray<Op>) {
  const history = yield* GitHistory;
  const names = yield* Ref.make(HashMap.empty<Sha, string>());
  const started = yield* Ref.make(HashSet.empty<Task>());
  const named = (subject: string) => (sha: Sha) =>
    Ref.update(names, (all) => (HashMap.has(all, sha) ? all : HashMap.set(all, sha, subject)));
  const start = (task: Task): Effect.Effect<void> =>
    Effect.gen(function* () {
      const already = yield* Ref.get(started);
      if (HashSet.has(already, task)) {
        return;
      }
      yield* Ref.update(started, HashSet.add(task));
      const from = task === "t2" ? Option.some<Task>("t1") : Option.none<Task>();
      yield* Effect.forEach(Option.toArray(from), start, { discard: true });
      yield* history
        .branch(branchOf(task), Option.match(from, { onNone: () => "main", onSome: branchOf }))
        .pipe(Effect.orDie);
    });
  yield* Effect.forEach(
    ops,
    (op, n) => {
      const kind = Match.valueTags(op, {
        Commit: () => "Commit",
        Merge: () => "Merge",
        Squash: () => "Squash",
      });
      const subject = `${kind} ${n}`;
      return Effect.andThen(
        start(op.task),
        Match.valueTags(op, {
          Commit: ({ files, task, trailered }) =>
            history.commit(
              branchOf(task),
              trailered
                ? Struct.assign(trailers(task, subject), { files })
                : { files, sections: [], session: null, subject, taskId: null },
            ),
          Merge: ({ task }) => history.merge(branchOf(task), "main"),
          Squash: ({ task }) => history.squash(branchOf(task), "main", trailers(task, subject)),
        }).pipe(Effect.flatMap(named(subject)), Effect.orDie),
      );
    },
    { discard: true },
  );
  const log = yield* Git.use((reader) => reader.log(manifest));
  const all = yield* Ref.get(names);
  const nameOf = (sha: Sha) => Option.getOrElse(HashMap.get(all, sha), () => "Initial commit");
  return Array.sort(
    Array.map(log, (commit): Named =>
      Struct.assign(Struct.omit(commit, ["parents", "sha"]), {
        parents: Array.map(commit.parents, nameOf),
      }),
    ),
    Order.mapInput(Order.String, ({ subject }: Named) => subject),
  );
});

it.effect.prop(
  "the in-memory layer reads the same history git does",
  [Schema.Array(Op).check(Schema.isMaxLength(8))],
  ([ops]) =>
    Effect.gen(function* () {
      const fromGit = yield* play(ops).pipe(Effect.provide(live));
      const fromMemory = yield* play(ops).pipe(Effect.provide(Git.memory()));
      expect(fromMemory).toStrictEqual(fromGit);
    }),
  { arbitrary: { runs: 12 }, timeout: 60_000 },
);

type Commit = Extract<Op, { readonly _tag: "Commit" }>;

const commitOn = (task: Task, files: Commit["files"], trailered: boolean): Op => ({
  _tag: "Commit",
  files,
  task,
  trailered,
});

/** What each layer reads after `ops`: git's first, then the in-memory layer's. */
const inBoth = (ops: ReadonlyArray<Op>) =>
  Effect.all([play(ops).pipe(Effect.provide(live)), play(ops).pipe(Effect.provide(Git.memory()))]);

it.effect("a task branch is read from its parent's branch, with its trailers and files", () =>
  Effect.gen(function* () {
    const logs = yield* inBoth([
      commitOn("t1", ["src/b.ts", "db/migrations/café 1.sql"], true),
      commitOn("t2", ["a.txt"], false),
    ]);
    expect(logs).toStrictEqual(
      Array.replicate(
        [
          {
            branch: "cairn-mvp/00-t1",
            files: ["db/migrations/café 1.sql", "src/b.ts"],
            onBase: false,
            parents: ["Initial commit"],
            sections: [SECTION],
            session: SESSION,
            subject: "Commit 0",
            taskId: "t1",
          },
          {
            branch: "cairn-mvp/00-t2",
            files: ["a.txt"],
            onBase: false,
            parents: ["Commit 0"],
            sections: [],
            session: null,
            subject: "Commit 1",
            taskId: null,
          },
        ],
        2,
      ),
    );
  }),
);

const landing = (commit: Named) =>
  Struct.pick(commit, ["branch", "files", "onBase", "parents", "subject"]);

it.effect(
  "a squash merge is a commit only the base shows; a merge puts the branch on the base",
  () =>
    Effect.gen(function* () {
      const logs = yield* inBoth([
        commitOn("t1", ["src/b.ts"], true),
        commitOn("t1", ["a.txt"], true),
        { _tag: "Squash", task: "t1" },
        commitOn("t1", ["a.txt"], true),
        { _tag: "Merge", task: "t1" },
      ]);
      expect(Array.map(logs, Array.map(landing))).toStrictEqual(
        Array.replicate(
          [
            {
              branch: null,
              files: ["src/b.ts"],
              onBase: true,
              parents: ["Initial commit"],
              subject: "Commit 0",
            },
            {
              branch: null,
              files: ["a.txt"],
              onBase: true,
              parents: ["Commit 0"],
              subject: "Commit 1",
            },
            {
              branch: null,
              files: ["a.txt"],
              onBase: true,
              parents: ["Commit 1"],
              subject: "Commit 3",
            },
            {
              branch: null,
              files: ["a.txt", "src/b.ts"],
              onBase: true,
              parents: ["Initial commit"],
              subject: "Squash 2",
            },
          ],
          2,
        ),
      );
    }),
);

it.effect(
  "a merge fast-forwards, and a stacked branch on the base is still read from its parent",
  () =>
    Effect.gen(function* () {
      const logs = yield* inBoth([
        commitOn("t1", ["src/b.ts"], true),
        commitOn("t2", ["a.txt"], true),
        { _tag: "Merge", task: "t2" },
        { _tag: "Squash", task: "t1" },
      ]);
      expect(Array.map(logs, Array.map(landing))).toStrictEqual(
        Array.replicate(
          [
            {
              branch: null,
              files: ["src/b.ts"],
              onBase: true,
              parents: ["Initial commit"],
              subject: "Commit 0",
            },
            {
              branch: "cairn-mvp/00-t2",
              files: ["a.txt"],
              onBase: true,
              parents: ["Commit 0"],
              subject: "Commit 1",
            },
            { branch: null, files: [], onBase: true, parents: ["Commit 1"], subject: "Squash 3" },
          ],
          2,
        ),
      );
    }),
);

it.effect("a base branch git does not have is an error, in both layers", () =>
  Effect.gen(function* () {
    const missing = Struct.assign(manifest, { baseBranch: "trunk" });
    const read = Git.use((reader) => reader.log(missing)).pipe(Effect.flip);
    const [fromGit, fromMemory] = yield* Effect.all([
      read.pipe(Effect.provide(live)),
      read.pipe(Effect.provide(Git.memory())),
    ]);
    expect(Array.map([fromGit, fromMemory], Schema.is(GitError))).toStrictEqual([true, true]);
    expect(fromGit.exitCode).toBe(128);
  }),
);
