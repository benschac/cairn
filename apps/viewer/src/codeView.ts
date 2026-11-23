import type { Sha, TaskId, Trace, TraceCommit, TraceTask } from "@cairn/contract";
import { Array, Number, Option, Order, Record, Schema, String, pipe } from "effect";
import { defineRouteUnion, literal, mapTo, slash, string } from "foldkit/route";

import { Screen, Shown } from "./model.ts";
import { columnOf, stackLayoutOf } from "./stacks.ts";

/** The server's patch routes the code view reads. */
const PatchRoute = defineRouteUnion({
  Commit: { sha: Schema.String },
  Diff: { base: Schema.String, head: Schema.String },
});

const commitRouter = pipe(
  literal("api"),
  slash(literal("commits")),
  slash(string("sha")),
  mapTo(PatchRoute.Commit),
);

const diffRouter = pipe(
  literal("api"),
  slash(literal("diffs")),
  slash(string("base")),
  slash(string("head")),
  mapTo(PatchRoute.Diff),
);

/** The first seven characters of a SHA. */
export const shortSha = (sha: string): string => String.takeLeft(sha, 7);

export const taskOf = (trace: Trace, id: TaskId): Option.Option<TraceTask> =>
  Array.findFirst(trace.tasks, (task) => task.id === id);

export const commitOf = (task: TraceTask, sha: Sha): Option.Option<TraceCommit> =>
  Array.findFirst(task.commits, (commit) => commit.sha === sha);

/** The task that holds a commit. */
export const ownerOf = (trace: Trace, sha: Sha): Option.Option<TraceTask> =>
  Array.findFirst(trace.tasks, (task) => Option.isSome(commitOf(task, sha)));

/**
 * The code view on a task: its whole diff, or one of its commits. None for a task the trace does
 * not have, or a commit the task does not hold.
 */
export const codeScreenOf = (
  trace: Trace,
  id: TaskId,
  maybeSha: Option.Option<Sha>,
): Option.Option<Screen> =>
  Option.flatMap(taskOf(trace, id), (task) =>
    Option.match(maybeSha, {
      onNone: () =>
        Option.some(
          Screen.Code({ maybeFile: Option.none(), shown: Shown.WholeTask(), taskId: id }),
        ),
      onSome: (sha) =>
        Option.map(commitOf(task, sha), (commit) =>
          Screen.Code({
            maybeFile: Option.none(),
            shown: Shown.OneCommit({ sha: commit.sha }),
            taskId: id,
          }),
        ),
    }),
  );

/** A whole task's diff runs from the first parent of its oldest commit to its newest commit. */
export const rangeOf = (
  task: TraceTask,
): Option.Option<{ readonly base: Sha; readonly head: Sha }> =>
  Option.all({
    base: Option.flatMap(Array.head(task.commits), (oldest) => Array.head(oldest.parents)),
    head: Option.map(Array.last(task.commits), (newest) => newest.sha),
  });

/**
 * The server route that holds what is shown: `/api/diffs/<base>/<head>` for a whole task and
 * `/api/commits/<sha>` for one commit. None for a task with no commits, a commit the task does not
 * hold, and a whole task whose oldest commit has no parent.
 */
export const patchPathOf = (task: TraceTask, shown: Shown): Option.Option<string> =>
  Shown.match(shown, {
    OneCommit: ({ sha }) =>
      Option.map(commitOf(task, sha), (commit) => commitRouter({ sha: commit.sha })),
    WholeTask: () => Option.map(rangeOf(task), ({ base, head }) => diffRouter({ base, head })),
  });

/** The commit whose session is shown: the selected one, or a whole task's newest. */
export const shownCommitOf = (task: TraceTask, shown: Shown): Option.Option<TraceCommit> =>
  Shown.match(shown, {
    OneCommit: ({ sha }) => commitOf(task, sha),
    WholeTask: () => Array.last(task.commits),
  });

/** The files of what is shown: one commit's, or the union of a whole task's commits', in order. */
export const filesOf = (task: TraceTask, shown: Shown): ReadonlyArray<string> =>
  Shown.match(shown, {
    OneCommit: ({ sha }) =>
      Option.match(commitOf(task, sha), {
        onNone: () => [],
        onSome: (commit) => commit.files,
      }),
    WholeTask: () => Array.dedupe(Array.flatMap(task.commits, (commit) => commit.files)),
  });

// DIRECTORY TREE

export interface TreeFile {
  readonly kind: "File";
  readonly name: string;
  readonly path: string;
}

export interface TreeDir {
  readonly kind: "Dir";
  readonly children: ReadonlyArray<TreeNode>;
  /** Its path relative to the root, which is also what its name leads with. */
  readonly path: string;
  /** One segment, or several where each directory had no other child: `src/view`. */
  readonly name: string;
}

export type TreeNode = TreeFile | TreeDir;

const joinPath = (parent: string, name: string): string =>
  String.isEmpty(parent) ? name : `${parent}/${name}`;

const isDir = (node: TreeNode): node is TreeDir => node.kind === "Dir";

/** Directories before files, each by name. */
const nodeOrder: Order.Order<TreeNode> = Order.combine(
  Order.mapInput(Order.Number, (node: TreeNode) => (isDir(node) ? 0 : 1)),
  Order.mapInput(Order.String, (node: TreeNode) => node.name),
);

const dirOf = (path: string, name: string, children: ReadonlyArray<TreeNode>): TreeDir => {
  // A directory whose only child is a directory joins it.
  const only = Array.match(children, {
    onEmpty: () => Option.none<TreeDir>(),
    onNonEmpty: (all) =>
      Array.isReadonlyArrayNonEmpty(Array.tailNonEmpty(all))
        ? Option.none<TreeDir>()
        : Option.filter(Option.some(Array.headNonEmpty(all)), isDir),
  });
  return Option.match(only, {
    onNone: () => ({ kind: "Dir", children, name, path }),
    onSome: (child) => ({ ...child, name: `${name}/${child.name}` }),
  });
};

const nodesOf = (
  parent: string,
  entries: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<TreeNode> => {
  const split = Array.getSomes(
    Array.map(entries, (segments) =>
      Array.matchLeft(segments, {
        onEmpty: () => Option.none(),
        onNonEmpty: (head, tail) => Option.some({ head, tail }),
      }),
    ),
  );
  const files = Array.map(
    Array.filter(split, ({ tail }) => Array.isReadonlyArrayEmpty(tail)),
    ({ head }): TreeNode => ({ kind: "File", name: head, path: joinPath(parent, head) }),
  );
  const dirs = pipe(
    split,
    Array.filter(({ tail }) => Array.isReadonlyArrayNonEmpty(tail)),
    Array.groupBy(({ head }) => head),
    Record.toEntries,
    Array.map(([name, group]): TreeNode => {
      const path = joinPath(parent, name);
      return dirOf(
        path,
        name,
        nodesOf(
          path,
          Array.map(group, ({ tail }) => tail),
        ),
      );
    }),
  );
  return Array.sort(Array.appendAll(dirs, files), nodeOrder);
};

/**
 * The files as a directory tree: directories first, each level by name, and a directory with one
 * directory in it joined to it (`src/view`). A path listed twice is one file.
 */
export const treeOf = (paths: ReadonlyArray<string>): ReadonlyArray<TreeNode> =>
  nodesOf(
    "",
    Array.map(Array.dedupe(Array.filter(paths, String.isNonEmpty)), (path) =>
      Array.filter(String.split(path, "/"), String.isNonEmpty),
    ),
  );

/** Every file path in a tree, in tree order. */
export const treePathsOf = (nodes: ReadonlyArray<TreeNode>): ReadonlyArray<string> =>
  Array.flatMap(nodes, (node) => (isDir(node) ? treePathsOf(node.children) : [node.path]));

// STACKS

/** One column of the stack layout: the branch it starts from, and its tasks from the bottom up. */
export interface StackColumn {
  readonly column: number;
  readonly from: string;
  readonly tasks: ReadonlyArray<TraceTask>;
}

/**
 * The stacks in `stackLayoutOf` column order. Each starts from the branch of the parent of its
 * first task, or the trace's base branch when that task has no parent.
 */
export const stackColumnsOf = (trace: Trace): ReadonlyArray<StackColumn> => {
  const layout = stackLayoutOf(trace.tasks);
  const column = columnOf(layout);
  const rowOf = (task: TraceTask): number =>
    Option.match(Record.get(layout, task.id), { onNone: () => 1, onSome: ({ row }) => row });
  return pipe(
    trace.tasks,
    Array.map((task) => column(task.id)),
    Array.dedupe,
    (numbers) => Array.sort(numbers, Number.Order),
    Array.map((number) => {
      const tasks = Array.sortWith(
        Array.filter(trace.tasks, (task) => column(task.id) === number),
        rowOf,
        Order.Number,
      );
      return {
        column: number,
        from: pipe(
          Array.head(tasks),
          Option.flatMapNullishOr((first) => first.parent),
          Option.flatMap((parent) => taskOf(trace, parent)),
          Option.match({ onNone: () => trace.baseBranch, onSome: (parent) => parent.branch }),
        ),
        tasks,
      };
    }),
  );
};
