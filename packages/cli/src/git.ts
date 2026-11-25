import { Manifest, Sha } from "@cairn/contract";
import { GitCommit } from "@cairn/core";
import {
  Array,
  Context,
  Effect,
  Equal,
  HashMap,
  HashSet,
  Layer,
  Option,
  Order,
  Predicate,
  Record,
  Schema,
  String,
  Struct,
  SynchronizedRef,
  pipe,
} from "effect";

/** Git refused a command, could not be started, or printed what Cairn cannot read. */
export class GitError extends Schema.TaggedError<GitError, { readonly brand: unique symbol }>()(
  "GitError",
  {
    args: Schema.Array(Schema.String),
    detail: Schema.String,
    /** `null` when git never ran, or ran fine and printed what does not decode. */
    exitCode: Schema.NullOr(Schema.Int),
  },
) {
  override get message() {
    return `git ${Array.join(this.args, " ")}: ${this.detail}`;
  }
}

/** What a commit says about itself: the fields of a `GitCommit` that do not depend on where it was read. */
export type Authored = Pick<GitCommit, "files" | "sections" | "session" | "subject" | "taskId">;

/** A commit as one `git log` prints it, before `Git.log` knows its branch and whether the base reaches it. */
export type Logged = Omit<GitCommit, "branch" | "onBase">;

/** A range `Git.log` reads: a task branch from its parent task's branch, or from `baseBranch`. */
interface Range {
  readonly branch: string;
  readonly from: string;
}

/**
 * Each task branch that exists, read from its parent task's branch, or from `baseBranch` when it has
 * no parent or its parent's branch is gone (a landed parent that Graphite deleted).
 */
export const rangesOf = (
  manifest: Manifest,
  exists: (branch: string) => boolean,
): ReadonlyArray<Range> => {
  const byId = Record.fromIterableBy(manifest.tasks, (task) => task.id);
  return Array.map(
    Array.filter(manifest.tasks, ({ branch }) => exists(branch)),
    (task) => ({
      branch: task.branch,
      from: pipe(
        Option.fromNullOr(task.parent),
        Option.flatMap((parent) => Record.get(byId, parent)),
        Option.map(({ branch }) => branch),
        Option.filter(exists),
        Option.getOrElse(() => manifest.baseBranch),
      ),
    }),
  );
};

/**
 * One entry per sha. A commit read from a task branch keeps the first branch it was read from; a
 * commit only `baseBranch` shows (a squash merge, or a branch merged and deleted) is listed only when
 * it carries a `Cairn-Task` trailer, with no branch.
 */
export const assemble = (
  onBase: HashSet.HashSet<Sha>,
  fromBranches: ReadonlyArray<{
    readonly branch: string;
    readonly commits: ReadonlyArray<Logged>;
  }>,
  fromBase: ReadonlyArray<Logged>,
): ReadonlyArray<GitCommit> =>
  Array.dedupeWith(
    Array.appendAll(
      Array.flatMap(fromBranches, ({ branch, commits }) =>
        Array.map(commits, (commit) =>
          Struct.assign(commit, { branch, onBase: HashSet.has(onBase, commit.sha) }),
        ),
      ),
      Array.map(
        Array.filter(fromBase, ({ taskId }) => Predicate.isNotNull(taskId)),
        (commit) => Struct.assign(commit, { branch: null, onBase: true }),
      ),
    ),
    (a, b) => a.sha === b.sha,
  );

/**
 * Git as derivation reads it (see `spec.status.cairn-status-and-cairn-approve`). `log` reads every
 * task branch of a manifest that exists, from its parent's branch, and the commits on `baseBranch`
 * that carry a `Cairn-Task` trailer, and says which of them `baseBranch` reaches. The live layer,
 * which runs git, is `layer` in `git-live.ts`, so the in-memory layer imports no process module.
 */
export class Git extends Context.Service<
  Git,
  {
    readonly log: (manifest: Manifest) => Effect.Effect<ReadonlyArray<GitCommit>, GitError>;
    /** `git config user.name`: none when it is unset or empty. */
    readonly userName: Effect.Effect<Option.Option<string>, GitError>;
  }
>()("@cairn/cli/Git") {
  /**
   * An in-memory repository with one empty commit on `baseBranch`. It provides `Git` and
   * `GitHistory`, which writes to the same repository, so a test builds a history and reads it back
   * as the live layer reads the same history from git. `userName` is what `git config user.name`
   * answers; it defaults to unset.
   */
  static readonly memory = (baseBranch = "main", userName: Option.Option<string> = Option.none()) =>
    Layer.effectContext(
      Effect.gen(function* () {
        const ref = yield* SynchronizedRef.make(initial(baseBranch));
        const change = <A>(f: (repo: Repo) => Effect.Effect<readonly [A, Repo], GitError>) =>
          SynchronizedRef.modifyEffect(ref, f);
        const history = GitHistory.of({
          branch: (name, from) =>
            change((repo) =>
              HashMap.has(repo.heads, name)
                ? Effect.fail(
                    refused(["branch", name, from], `a branch named '${name}' already exists`),
                  )
                : Effect.map(headOf(repo, from), (sha) => [
                    undefined,
                    Struct.evolve(repo, { heads: HashMap.set(name, sha) }),
                  ]),
            ),
          commit: (branch, authored) =>
            change((repo) =>
              Effect.map(headOf(repo, branch), (head) =>
                commitTo(repo, branch, {
                  authored: Struct.evolve(authored, { files: sortedPaths }),
                  parents: [head],
                  tree: (sha) =>
                    Array.reduce(authored.files, nodeOf(repo, head).tree, (tree, path) =>
                      HashMap.set(tree, path, sha),
                    ),
                }),
              ),
            ),
          merge: (branch, into) =>
            change((repo) =>
              Effect.map(both(repo, into, branch), ([ours, theirs]) =>
                Option.match(fastForward(repo, ours, theirs), {
                  onNone: () =>
                    commitTo(repo, into, {
                      authored: {
                        files: [],
                        sections: [],
                        session: null,
                        subject: mergeSubject(branch),
                        taskId: null,
                      },
                      parents: [ours, theirs],
                      tree: () => merged(repo, ours, theirs),
                    }),
                  onSome: (head) => [head, Struct.evolve(repo, { heads: HashMap.set(into, head) })],
                }),
              ),
            ),
          squash: (branch, into, authored) =>
            change((repo) =>
              Effect.map(both(repo, into, branch), ([ours, theirs]) => {
                const before = nodeOf(repo, ours).tree;
                const after = Option.match(fastForward(repo, ours, theirs), {
                  onNone: () => merged(repo, ours, theirs),
                  onSome: (head) => nodeOf(repo, head).tree,
                });
                const changed = Array.filter(
                  Array.fromIterable(HashMap.keys(after)),
                  (path) => !Equal.equals(HashMap.get(before, path), HashMap.get(after, path)),
                );
                return commitTo(repo, into, {
                  authored: Struct.assign(authored, { files: sortedPaths(changed) }),
                  parents: [ours],
                  tree: () => after,
                });
              }),
            ),
        });
        const git = Git.of({
          userName: Effect.succeed(userName),
          log: (manifest) =>
            Effect.flatMap(SynchronizedRef.get(ref), (repo) => {
              const reach = (name: string) =>
                Option.match(HashMap.get(repo.heads, name), {
                  onNone: () => HashSet.empty<Sha>(),
                  onSome: (head) => ancestorsOf(repo, head),
                });
              // Newest first, as git log prints them.
              const listed = (shas: HashSet.HashSet<Sha>): ReadonlyArray<Logged> =>
                Array.map(Array.sort(Array.fromIterable(shas), Order.flip(Order.String)), (sha) =>
                  Struct.omit(nodeOf(repo, sha), ["tree"]),
                );
              const onBase = reach(manifest.baseBranch);
              return Effect.as(
                headOf(repo, manifest.baseBranch),
                assemble(
                  onBase,
                  Array.map(
                    rangesOf(manifest, (branch) => HashMap.has(repo.heads, branch)),
                    ({ branch, from }) => ({
                      branch,
                      commits: listed(HashSet.difference(reach(branch), reach(from))),
                    }),
                  ),
                  listed(onBase),
                ),
              );
            }),
        });
        return Context.make(Git, git).pipe(Context.add(GitHistory, history));
      }),
    );
}

/**
 * Writes history the way an orchestrator and a merge do. `Git.memory` provides it over its in-memory
 * repository; the live layer's test provides one that runs git. A merge fast-forwards when it can
 * and otherwise makes a merge commit with `mergeSubject`; a merge and a squash both resolve a
 * conflict in favour of the branch merged in (`-X theirs`). A merge commit has no files, as
 * `git log --name-only` shows it.
 */
export class GitHistory extends Context.Service<
  GitHistory,
  {
    /** Creates `name` at the head of `from`. */
    readonly branch: (name: string, from: string) => Effect.Effect<void, GitError>;
    /** A commit on `branch` that writes new content to each of its files. */
    readonly commit: (branch: string, authored: Authored) => Effect.Effect<Sha, GitError>;
    /** Merges `branch` into `into` and returns the new head of `into`. */
    readonly merge: (branch: string, into: string) => Effect.Effect<Sha, GitError>;
    /** One commit on `into` with what merging `branch` would change, and the trailers given. */
    readonly squash: (
      branch: string,
      into: string,
      authored: Omit<Authored, "files">,
    ) => Effect.Effect<Sha, GitError>;
  }
>()("@cairn/cli/GitHistory") {}

/** The subject of the merge commit `GitHistory.merge` makes. */
export const mergeSubject = (branch: string) => `Merge branch '${branch}'`;

const refused = (args: ReadonlyArray<string>, detail: string) =>
  new GitError({ args, detail, exitCode: 128 });

/** A commit in the in-memory repository: what it says, and the content of every file it has. */
interface Node extends Logged {
  /** Each path's content, named by the commit that last wrote it. */
  readonly tree: HashMap.HashMap<string, string>;
}

interface Repo {
  readonly heads: HashMap.HashMap<string, Sha>;
  readonly nodes: HashMap.HashMap<Sha, Node>;
}

/** The `n`th commit's sha, so shas sort in the order commits were made. */
const shaOf = (n: number): Sha => Sha.make(String.padStart(40, "0")(n.toString(16)));

const ROOT = shaOf(0);

const initial = (baseBranch: string): Repo => ({
  heads: HashMap.make([baseBranch, ROOT]),
  nodes: HashMap.make([
    ROOT,
    {
      files: [],
      parents: [],
      sections: [],
      session: null,
      sha: ROOT,
      subject: "Initial commit",
      taskId: null,
      tree: HashMap.empty(),
    },
  ]),
});

const sortedPaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.sort(Array.dedupe(paths), Order.String);

/** The heads of `into` and `branch`, for a merge of `branch` into `into`. */
const both = (repo: Repo, into: string, branch: string) =>
  Effect.all([headOf(repo, into), headOf(repo, branch)]);

const headOf = (repo: Repo, branch: string) =>
  Effect.fromOption(HashMap.get(repo.heads, branch)).pipe(
    Effect.mapError(() => refused(["rev-parse", branch], `unknown revision '${branch}'`)),
  );

/** A head or a parent always has its node; a missing one is a bug in this module, so it throws. */
const nodeOf = (repo: Repo, sha: Sha): Node =>
  Option.getOrThrowWith(
    HashMap.get(repo.nodes, sha),
    () => new globalThis.Error(`no commit ${sha}`),
  );

/** `sha` and every commit it reaches. */
const ancestorsOf = (repo: Repo, sha: Sha): HashSet.HashSet<Sha> => {
  const walk = (seen: HashSet.HashSet<Sha>, next: Sha): HashSet.HashSet<Sha> =>
    HashSet.has(seen, next)
      ? seen
      : Array.reduce(nodeOf(repo, next).parents, HashSet.add(seen, next), walk);
  return walk(HashSet.empty(), sha);
};

/** The head `ours` takes when merging `theirs` needs no merge commit: itself, or `theirs` by fast-forward. */
const fastForward = (repo: Repo, ours: Sha, theirs: Sha): Option.Option<Sha> =>
  HashSet.has(ancestorsOf(repo, ours), theirs)
    ? Option.some(ours)
    : HashSet.has(ancestorsOf(repo, theirs), ours)
      ? Option.some(theirs)
      : Option.none();

/** The common ancestor nearest both: the one that reaches the most commits. */
const mergeBaseOf = (repo: Repo, ours: Sha, theirs: Sha): Option.Option<Node> =>
  Array.match(
    Array.fromIterable(HashSet.intersection(ancestorsOf(repo, ours), ancestorsOf(repo, theirs))),
    {
      onEmpty: () => Option.none(),
      onNonEmpty: (common) =>
        Option.some(
          nodeOf(
            repo,
            Array.max(
              common,
              Order.mapInput(Order.Number, (sha: Sha) => HashSet.size(ancestorsOf(repo, sha))),
            ),
          ),
        ),
    },
  );

/** A three-way merge of trees with `-X theirs`: a path `theirs` changed takes its content. */
const merged = (repo: Repo, ours: Sha, theirs: Sha): HashMap.HashMap<string, string> => {
  const base = Option.match(mergeBaseOf(repo, ours, theirs), {
    onNone: () => HashMap.empty<string, string>(),
    onSome: ({ tree }) => tree,
  });
  return HashMap.reduce(nodeOf(repo, theirs).tree, nodeOf(repo, ours).tree, (tree, content, path) =>
    Equal.equals(HashMap.get(base, path), Option.some(content))
      ? tree
      : HashMap.set(tree, path, content),
  );
};

/** Adds a commit on top of `branch`, whose tree may name the new commit's sha. */
const commitTo = (
  repo: Repo,
  branch: string,
  next: {
    readonly authored: Authored;
    readonly parents: ReadonlyArray<Sha>;
    readonly tree: (sha: Sha) => HashMap.HashMap<string, string>;
  },
): readonly [Sha, Repo] => {
  const sha = shaOf(HashMap.size(repo.nodes));
  return [
    sha,
    {
      heads: HashMap.set(repo.heads, branch, sha),
      nodes: HashMap.set(
        repo.nodes,
        sha,
        Struct.assign(next.authored, { parents: next.parents, sha, tree: next.tree(sha) }),
      ),
    },
  ];
};
