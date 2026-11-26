import type { Trace, TraceCommit, TraceTask } from "@cairn/contract";
import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Array, Match, Option } from "effect";

import {
  filesOf,
  shortSha,
  stackColumnsOf,
  treeOf,
  type StackColumn,
  type TreeNode,
} from "../codeView.ts";
import { styleText } from "../effect-ui/attributes.ts";
import type { CodeScreen } from "../model.ts";
import { Shown } from "../model.ts";
import { dotView, gateView, labelView, tagView } from "../ui/marks.ts";

/** The message constructors the tree's view needs; the app supplies its own. */
export interface TreeMessages<Message> {
  readonly onClickCommit: (sha: TraceCommit["sha"]) => Message;
  readonly onClickFile: (path: string) => Message;
  readonly onClickTask: (id: TraceTask["id"]) => Message;
}

/** The tree's width; the diff takes the rest and the session has its own. */
export const TREE_WIDTH = "280px";

// NOTE: native buttons with type="button", as in the drawer.
const rowButton = <Message>(
  h: Html.H<Message>,
  dataName: string,
  dataValue: string,
  isCurrent: boolean,
  onClick: Message,
  content: View.Input<Message>,
  label?: string,
) =>
  h.button
    .attr("type", "button")
    .class("row")
    .on("click", onClick)
    .attr(`data-${dataName}`, dataValue)
    .attr("aria-current", isCurrent ? "true" : undefined)
    .attr("aria-label", label)
    .children(content);

/** A directory is a label, not a button: there is nothing to do with it. */
const nodeView = <Message>(
  h: Html.H<Message>,
  node: TreeNode,
  maybeFile: Option.Option<string>,
  messages: TreeMessages<Message>,
): View.Content<Message> =>
  Match.value(node).pipe(
    Match.discriminator("kind")("Dir", (dir) =>
      h.li
        .key(dir.path)
        .attr("data-tree-dir", dir.path)
        .children(
          h.span(`${dir.name}/`),
          h.ul
            .class("tree-list")
            .children(Array.map(dir.children, (child) => nodeView(h, child, maybeFile, messages))),
        ),
    ),
    Match.discriminator("kind")("File", (file) =>
      h.li
        .key(file.path)
        .children(
          rowButton(
            h,
            "tree-file",
            file.path,
            Option.contains(maybeFile, file.path),
            messages.onClickFile(file.path),
            file.name,
          ),
        ),
    ),
    Match.exhaustive,
  );

const filesView = <Message>(
  h: Html.H<Message>,
  files: ReadonlyArray<string>,
  maybeFile: Option.Option<string>,
  messages: TreeMessages<Message>,
) =>
  h.ul
    .class("tree-list")
    .attr("data-tree-files", "")
    .children(Array.map(treeOf(files), (node) => nodeView(h, node, maybeFile, messages)));

const commitRow = <Message>(
  h: Html.H<Message>,
  task: TraceTask,
  commit: TraceCommit,
  code: CodeScreen,
  messages: TreeMessages<Message>,
) => {
  const isCurrent =
    code.taskId === task.id &&
    Shown.match(code.shown, { OneCommit: ({ sha }) => sha === commit.sha, WholeTask: () => false });
  return h.li
    .key(commit.sha)
    .children(
      isCurrent && filesView(h, commit.files, code.maybeFile, messages),
      rowButton(h, "tree-commit", commit.sha, isCurrent, messages.onClickCommit(commit.sha), [
        `${commit.subject} `,
        tagView(h, "sha", shortSha(commit.sha)),
      ]),
    );
};

const taskRow = <Message>(
  h: Html.H<Message>,
  task: TraceTask,
  code: CodeScreen,
  messages: TreeMessages<Message>,
) => {
  const isSelected = code.taskId === task.id;
  const isWhole = isSelected && Shown.guards.WholeTask(code.shown);
  return h.li
    .key(task.id)
    .attr("data-tree-task-item", task.id)
    .children(
      rowButton(
        h,
        "tree-task",
        task.id,
        isWhole,
        messages.onClickTask(task.id),
        [
          dotView(h, task.status),
          tagView(h, "task", task.id),
          task.title,
          task.gate.required && gateView(h),
        ],
        // The dot is hidden from a screen reader, so the label says the status and the gate.
        `${task.id} ${task.title}, ${task.status}${task.gate.required ? ", gated" : ""}`,
      ),
      h.ol
        .class("tree-list")
        .attr("data-tree-commits", task.id)
        .children(Array.map(task.commits, (commit) => commitRow(h, task, commit, code, messages))),
      isWhole && filesView(h, filesOf(task, code.shown), code.maybeFile, messages),
    );
};

const stackView = <Message>(
  h: Html.H<Message>,
  column: StackColumn,
  code: CodeScreen,
  messages: TreeMessages<Message>,
) =>
  h.section
    .key(String(column.column))
    .attr("data-tree-stack", String(column.column))
    .children(
      h.h3(labelView(h, `From ${column.from}`)),
      h.ol
        .class("tree-list")
        .children(Array.map(column.tasks, (task) => taskRow(h, task, code, messages))),
    );

/**
 * The stacks as a tree with its own scroll: each headed by the branch it starts from, its tasks
 * from the bottom up, each task's commits oldest first, and the selected task's or commit's files
 * as a directory tree under it. Every row that does something is a button.
 */
export const treeView = <Message>(
  h: Html.H<Message>,
  trace: Trace,
  code: CodeScreen,
  messages: TreeMessages<Message>,
) =>
  h.nav
    .class("code-pane")
    .attr("aria-label", "Stacks")
    .attr("data-code-pane", "tree")
    // The width is the pane's own; the scroll stays with it.
    .attr("style", styleText({ "overflow-y": "auto", width: TREE_WIDTH }))
    .children(Array.map(stackColumnsOf(trace), (column) => stackView(h, column, code, messages)));
