import { Sha } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Order, Schema, String, Struct } from "effect";

import {
  filesOf,
  patchPathOf,
  stackColumnsOf,
  treeOf,
  treePathsOf,
  type TreeNode,
} from "../src/codeView.ts";
import { demoTrace } from "../src/demo.ts";
import { Shown, WHOLE_TASK } from "../src/model.ts";

const sha = (character: string) => Sha.make(String.repeat(40)(character));

const base = Option.getOrThrow(
  Array.head(Array.filter(demoTrace.tasks, (t) => Array.isReadonlyArrayNonEmpty(t.commits))),
);
const template = Option.getOrThrow(Array.head(base.commits));
const first = Struct.evolve(template, {
  files: () => ["src/a.ts", "src/view/b.ts"],
  parents: () => [sha("0")],
  sha: () => sha("a"),
});
const second = Struct.evolve(template, {
  files: () => ["src/view/b.ts", "docs/c.md"],
  parents: () => [sha("a")],
  sha: () => sha("b"),
});
const stacked = Struct.evolve(base, { commits: () => [first, second] });
const empty = Struct.evolve(base, { commits: () => [] });

it("a whole task's patch runs from its oldest commit's first parent to its newest commit", () => {
  assert(patchPathOf(stacked, WHOLE_TASK)).toEqual(
    Option.some(`/api/diffs/${sha("0")}/${sha("b")}`),
  );
});

it("one commit's patch is its own route, and a commit the task does not hold has none", () => {
  assert(patchPathOf(stacked, Shown.OneCommit({ sha: sha("a") }))).toEqual(
    Option.some(`/api/commits/${sha("a")}`),
  );
  assert(patchPathOf(stacked, Shown.OneCommit({ sha: sha("c") }))).toEqual(Option.none());
});

it("a task with no commits has no patch, whole or by commit", () => {
  assert(patchPathOf(empty, WHOLE_TASK)).toEqual(Option.none());
  assert(patchPathOf(empty, Shown.OneCommit({ sha: sha("a") }))).toEqual(Option.none());
});

it("a whole task's files are the union of its commits' files, and a commit's are its own", () => {
  assert(filesOf(stacked, WHOLE_TASK)).toEqual(["src/a.ts", "src/view/b.ts", "docs/c.md"]);
  assert(filesOf(stacked, Shown.OneCommit({ sha: sha("b") }))).toEqual([
    "src/view/b.ts",
    "docs/c.md",
  ]);
  assert(filesOf(stacked, Shown.OneCommit({ sha: sha("c") }))).toEqual([]);
});

const shape = (nodes: ReadonlyArray<TreeNode>): ReadonlyArray<string> =>
  Array.flatMap(nodes, (node) =>
    node.kind === "Dir"
      ? Array.prepend(
          Array.map(shape(node.children), (line) => `  ${line}`),
          `${node.name}/`,
        )
      : [node.name],
  );

it("a directory with one directory in it joins it, and directories come first", () => {
  assert(shape(treeOf(["README.md", "src/view/a.ts", "src/view/b.ts", "src/x.ts"]))).toEqual([
    "src/",
    "  view/",
    "    a.ts",
    "    b.ts",
    "  x.ts",
    "README.md",
  ]);
  assert(shape(treeOf(["packages/core/src/a.ts", "packages/core/src/view/b.ts"]))).toEqual([
    "packages/core/src/",
    "  view/",
    "    b.ts",
    "  a.ts",
  ]);
});

const Segment = Schema.String.check(Schema.isPattern(/^[a-z]{1,4}$/));
const FileName = Schema.String.check(Schema.isPattern(/^[a-z]{1,4}\.ts$/));
const FilePath = Schema.Struct({ directories: Schema.Array(Segment), name: FileName });
const pathOf = ({ directories, name }: typeof FilePath.Type) =>
  Array.join(Array.append(directories, name), "/");

const hasLoneDirectory = (nodes: ReadonlyArray<TreeNode>): boolean =>
  Array.some(nodes, (node) =>
    node.kind === "File"
      ? false
      : Array.isReadonlyArrayEmpty(node.children) ||
        (Array.isReadonlyArrayNonEmpty(node.children) &&
          Array.isReadonlyArrayEmpty(Array.tailNonEmpty(node.children)) &&
          Array.headNonEmpty(node.children).kind === "Dir") ||
        hasLoneDirectory(node.children),
  );

it.prop(
  "the tree holds every path once, and no directory is empty or holds only a directory",
  { files: Schema.Array(FilePath) },
  ({ files }) => {
    const paths = Array.map(files, pathOf);
    const tree = treeOf(paths);
    assert(Array.sort(treePathsOf(tree), Order.String)).toEqual(
      Array.sort(Array.dedupe(paths), Order.String),
    );
    assert(hasLoneDirectory(tree)).toBe(false);
  },
);

const ids = (tasks: ReadonlyArray<{ readonly id: string }>) =>
  Array.sort(
    Array.map(tasks, (t) => t.id),
    Order.String,
  );

it("the stacks list every task once, columns in order, each from its parent's branch or the base", () => {
  const columns = stackColumnsOf(demoTrace);
  assert(ids(Array.flatMap(columns, (column) => column.tasks))).toEqual(ids(demoTrace.tasks));
  const numbers = Array.map(columns, (column) => column.column);
  assert(numbers).toEqual(Array.sort(numbers, Order.Number));
  Array.forEach(columns, (column) => {
    const head = Option.getOrThrow(Array.head(column.tasks));
    const parent = Option.flatMap(Option.fromNullOr(head.parent), (id) =>
      Array.findFirst(demoTrace.tasks, (t) => t.id === id),
    );
    assert(column.from).toBe(
      Option.match(parent, { onNone: () => demoTrace.baseBranch, onSome: (found) => found.branch }),
    );
  });
});
