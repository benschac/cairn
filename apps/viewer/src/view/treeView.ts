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

/** The message constructors the tree's view needs; the app supplies its own. */
export interface TreeMessages<Message> {
  readonly onClickCommit: (sha: TraceCommit["sha"]) => Message;
  readonly onClickFile: (path: string) => Message;
  readonly onClickTask: (id: TraceTask["id"]) => Message;
}

/** The tree's width; the diff takes the rest and the session has its own. */
export const TREE_WIDTH = "280px";

const rowStyle = (isCurrent: boolean) => ({
  background: isCurrent ? "#e0e7ff" : "transparent",
  border: "0",
  cursor: "pointer",
  display: "block",
  "font-weight": isCurrent ? "600" : "400",
  padding: "2px 6px",
  "text-align": "left",
  width: "100%",
});

const listStyle = { "list-style": "none", margin: "0", "padding-left": "12px" };

// NOTE: native buttons with Type("button"), as in the drawer. @foldkit/ui's Button.view adds only
// Tabindex(0) over that, so it is not a dependency.
const rowButton = <Message>(
  h: HtmlBuilder<Message>,
  dataName: string,
  dataValue: string,
  isCurrent: boolean,
  onClick: Message,
  label: string,
): Html =>
  h.button(
    Array.appendAll(
      [
        h.Type("button"),
        h.OnClick(onClick),
        h.Style(rowStyle(isCurrent)),
        h.DataAttribute(dataName, dataValue),
      ],
      isCurrent ? [h.AriaCurrent("true")] : [],
    ),
    [label],
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
            [h.Style(listStyle)],
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
            file.name,
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
    [h.Style(listStyle), h.DataAttribute("tree-files", "")],
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
      rowButton(
        h,
        "tree-commit",
        commit.sha,
        isCurrent,
        messages.onClickCommit(commit.sha),
        `${commit.subject} ${shortSha(commit.sha)}`,
      ),
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
          `${task.id} ${task.title}, ${task.status}${task.gate.required ? ", gated" : ""}`,
        ),
        h.ol(
          [h.Style(listStyle), h.DataAttribute("tree-commits", task.id)],
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
      h.h3([h.Style({ "font-size": "13px", margin: "8px 0 4px" })], [`From ${column.from}`]),
      h.ol(
        [h.Style(listStyle)],
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
      h.AriaLabel("Stacks"),
      h.DataAttribute("code-pane", "tree"),
      h.Style({
        "border-right": "1px solid #cbd5e1",
        "box-sizing": "border-box",
        flex: "none",
        "overflow-y": "auto",
        padding: "8px",
        width: TREE_WIDTH,
      }),
    ],
    Array.map(stackColumnsOf(trace), (column) => stackView(column, code, h, messages)),
  );
