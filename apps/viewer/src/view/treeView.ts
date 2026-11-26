import type { Trace, TraceCommit, TraceTask } from "@cairn/contract";
import { Array, Match, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  filesOf,
  shortSha,
  stackColumnsOf,
  treeOf,
  type StackColumn,
  type TreeNode,
} from "../codeView.ts";
import type { CodeScreen } from "../model.ts";
import { Shown } from "../model.ts";
import { dotView, gateView, labelView, tagView } from "../foldkit/marks.ts";

/** The message constructors the tree's view needs; the app supplies its own. */
export interface TreeMessages<Message> {
  readonly onClickCommit: (sha: TraceCommit["sha"]) => Message;
  readonly onClickFile: (path: string) => Message;
  readonly onClickTask: (id: TraceTask["id"]) => Message;
}

/** The tree's width; the diff takes the rest and the session has its own. */
export const TREE_WIDTH = "280px";

// NOTE: native buttons with Type("button"), as in the drawer. @foldkit/ui's Button.view adds only
// Tabindex(0) over that, so it is not a dependency.
const rowButton = <Message>(
  h: HtmlBuilder<Message>,
  dataName: string,
  dataValue: string,
  isCurrent: boolean,
  onClick: Message,
  content: ReadonlyArray<Html | string>,
  label?: string,
): Html =>
  h.button(
    Array.flatten([
      [h.Type("button"), h.Class("row"), h.OnClick(onClick), h.DataAttribute(dataName, dataValue)],
      isCurrent ? [h.AriaCurrent("true")] : [],
      Array.fromOption(Option.map(Option.fromNullishOr(label), (name) => h.AriaLabel(name))),
    ]),
    content,
  );

/** A directory is a label, not a button: there is nothing to do with it. */
const nodeView = <Message>(
  node: TreeNode,
  maybeFile: Option.Option<string>,
  h: HtmlBuilder<Message>,
  messages: TreeMessages<Message>,
): Html =>
  Match.value(node).pipe(
    Match.discriminator("kind")("Dir", (dir) =>
      h.keyed("li")(
        dir.path,
        [h.DataAttribute("tree-dir", dir.path)],
        [
          h.span([], [`${dir.name}/`]),
          h.ul(
            [h.Class("tree-list")],
            Array.map(dir.children, (child) => nodeView(child, maybeFile, h, messages)),
          ),
        ],
      ),
    ),
    Match.discriminator("kind")("File", (file) =>
      h.keyed("li")(
        file.path,
        [],
        [
          rowButton(
            h,
            "tree-file",
            file.path,
            Option.contains(maybeFile, file.path),
            messages.onClickFile(file.path),
            [file.name],
          ),
        ],
      ),
    ),
    Match.exhaustive,
  );

const filesView = <Message>(
  files: ReadonlyArray<string>,
  maybeFile: Option.Option<string>,
  h: HtmlBuilder<Message>,
  messages: TreeMessages<Message>,
): Html =>
  h.ul(
    [h.Class("tree-list"), h.DataAttribute("tree-files", "")],
    Array.map(treeOf(files), (node) => nodeView(node, maybeFile, h, messages)),
  );

const commitRow = <Message>(
  task: TraceTask,
  commit: TraceCommit,
  code: CodeScreen,
  h: HtmlBuilder<Message>,
  messages: TreeMessages<Message>,
): Html => {
  const isCurrent =
    code.taskId === task.id &&
    Shown.match(code.shown, { OneCommit: ({ sha }) => sha === commit.sha, WholeTask: () => false });
  return h.keyed("li")(
    commit.sha,
    [],
    Array.prependAll(isCurrent ? [filesView(commit.files, code.maybeFile, h, messages)] : [], [
      rowButton(h, "tree-commit", commit.sha, isCurrent, messages.onClickCommit(commit.sha), [
        `${commit.subject} `,
        tagView("sha", shortSha(commit.sha), h),
      ]),
    ]),
  );
};

const taskRow = <Message>(
  task: TraceTask,
  code: CodeScreen,
  h: HtmlBuilder<Message>,
  messages: TreeMessages<Message>,
): Html => {
  const isSelected = code.taskId === task.id;
  const isWhole = isSelected && Shown.guards.WholeTask(code.shown);
  return h.keyed("li")(
    task.id,
    [h.DataAttribute("tree-task-item", task.id)],
    Array.appendAll(
      [
        rowButton(
          h,
          "tree-task",
          task.id,
          isWhole,
          messages.onClickTask(task.id),
          Array.flatten([
            [dotView(task.status, h), tagView("task", task.id, h), task.title],
            task.gate.required ? [gateView(h)] : [],
          ]),
          // The dot is hidden from a screen reader, so the label says the status and the gate.
          `${task.id} ${task.title}, ${task.status}${task.gate.required ? ", gated" : ""}`,
        ),
        h.ol(
          [h.Class("tree-list"), h.DataAttribute("tree-commits", task.id)],
          Array.map(task.commits, (commit) => commitRow(task, commit, code, h, messages)),
        ),
      ],
      isWhole ? [filesView(filesOf(task, code.shown), code.maybeFile, h, messages)] : [],
    ),
  );
};

const stackView = <Message>(
  column: StackColumn,
  code: CodeScreen,
  h: HtmlBuilder<Message>,
  messages: TreeMessages<Message>,
): Html =>
  h.keyed("section")(
    String(column.column),
    [h.DataAttribute("tree-stack", String(column.column))],
    [
      h.h3([], [labelView(`From ${column.from}`, h)]),
      h.ol(
        [h.Class("tree-list")],
        Array.map(column.tasks, (task) => taskRow(task, code, h, messages)),
      ),
    ],
  );

/**
 * The stacks as a tree with its own scroll: each headed by the branch it starts from, its tasks
 * from the bottom up, each task's commits oldest first, and the selected task's or commit's files
 * as a directory tree under it. Every row that does something is a button.
 */
export const treeView = <Message>(
  trace: Trace,
  code: CodeScreen,
  h: HtmlBuilder<Message>,
  messages: TreeMessages<Message>,
): Html =>
  h.nav(
    [
      h.Class("code-pane"),
      h.AriaLabel("Stacks"),
      h.DataAttribute("code-pane", "tree"),
      // The width is the pane's own; the scroll stays with it.
      h.Style({ "overflow-y": "auto", width: TREE_WIDTH }),
    ],
    Array.map(stackColumnsOf(trace), (column) => stackView(column, code, h, messages)),
  );
