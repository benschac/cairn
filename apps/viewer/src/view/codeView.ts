import type { Trace, TraceTask } from "@cairn/contract";
import { Array, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { patchPathOf, rangeOf, shortSha, shownCommitOf, taskOf } from "../codeView.ts";
import { Shown, type CodeScreen } from "../model.ts";
import { treeView, type TreeMessages } from "./treeView.ts";

/** The message constructors the code view's view needs; the app supplies its own. */
export interface CodeMessages<Message> extends TreeMessages<Message> {
  readonly onBack: Message;
}

/** The session pane's width; the tree has its own and the diff takes the rest. */
const SESSION_WIDTH = "420px";

const paneStyle = {
  "box-sizing": "border-box",
  "min-width": "0",
  "overflow-y": "auto",
  padding: "8px 12px",
};

const plural = (count: number): string => (count === 1 ? "1 commit" : `${count} commits`);

/** What the bar says is shown: a whole task's commit count and range, or one commit. */
const shownText = (task: TraceTask, shown: Shown): string =>
  Shown.match(shown, {
    OneCommit: ({ sha }) =>
      Option.match(
        Array.findFirst(task.commits, (commit) => commit.sha === sha),
        {
          onNone: () => shortSha(sha),
          onSome: (commit) => `${commit.subject} ${shortSha(commit.sha)}`,
        },
      ),
    WholeTask: () =>
      Option.match(rangeOf(task), {
        onNone: () => plural(Array.length(task.commits)),
        onSome: ({ base, head }) =>
          `${plural(Array.length(task.commits))} ${shortSha(base)}..${shortSha(head)}`,
      }),
  });

const barView = <Message>(
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  h: HtmlBuilder<Message>,
  messages: CodeMessages<Message>,
): Html =>
  h.header(
    [
      h.DataAttribute("code-bar", ""),
      h.Style({
        "align-items": "center",
        "border-bottom": "1px solid #cbd5e1",
        display: "flex",
        flex: "none",
        gap: "16px",
        padding: "8px 12px",
      }),
    ],
    Array.prepend(
      Option.match(task, {
        onNone: () => [h.span([h.Role("alert")], [`No task ${code.taskId} in the trace.`])],
        onSome: (found) => [
          h.h1([h.Style({ "font-size": "16px", margin: "0" })], [`${found.id} ${found.branch}`]),
          h.span([h.DataAttribute("shown", "")], [shownText(found, code.shown)]),
        ],
      }),
      h.button([h.Type("button"), h.OnClick(messages.onBack)], ["Back to canvas"]),
    ),
  );

/** The middle pane: where the diff for what is shown will be drawn, or why there is none. */
const diffPane = <Message>(
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.AriaLabel("Diff"),
      h.DataAttribute("code-pane", "diff"),
      h.Style({ ...paneStyle, flex: "1" }),
    ],
    [
      Option.match(task, {
        onNone: () => h.p([], ["This task is not in the trace."]),
        onSome: (found) =>
          Option.match(patchPathOf(found, code.shown), {
            onNone: () =>
              h.p(
                [],
                [
                  Array.isReadonlyArrayEmpty(found.commits)
                    ? "This task has no commits."
                    : "This task has no diff to show.",
                ],
              ),
            onSome: (path) =>
              h.div(
                Array.prepend(
                  Array.map(Array.fromOption(code.maybeFile), (file) =>
                    h.DataAttribute("file", file),
                  ),
                  h.DataAttribute("patch-path", path),
                ),
                [path],
              ),
          }),
      }),
    ],
  );

/** The right pane: the session of the selected commit, or of a whole task's latest commit. */
const sessionPane = <Message>(
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  h: HtmlBuilder<Message>,
): Html =>
  h.aside(
    [
      h.AriaLabel("Session"),
      h.DataAttribute("code-pane", "session"),
      h.Style({
        ...paneStyle,
        "border-left": "1px solid #cbd5e1",
        flex: "none",
        width: SESSION_WIDTH,
      }),
    ],
    [
      Option.match(
        Option.flatMap(task, (found) => shownCommitOf(found, code.shown)),
        {
          onNone: () => h.p([], ["No session: there is no commit."]),
          onSome: (commit) =>
            Option.match(Option.fromNullOr(commit.session), {
              onNone: () => h.p([], ["No session was recorded for this commit."]),
              onSome: (id) => h.p([h.DataAttribute("session-id", id)], [`Session ${id}`]),
            }),
        },
      ),
    ],
  );

/**
 * The code view: the whole window under a top bar, in three panes. The tree and the session each
 * scroll on their own; the diff takes the rest.
 */
export const codeView = <Message>(
  trace: Trace,
  code: CodeScreen,
  h: HtmlBuilder<Message>,
  messages: CodeMessages<Message>,
): Html => {
  const task = taskOf(trace, code.taskId);
  return h.div(
    [
      h.DataAttribute("code-view", code.taskId),
      h.Style({
        background: "#ffffff",
        bottom: "0",
        display: "flex",
        "flex-direction": "column",
        left: "0",
        position: "fixed",
        right: "0",
        top: "0",
      }),
    ],
    [
      barView(task, code, h, messages),
      h.div(
        [h.Style({ display: "flex", flex: "1", "min-height": "0" })],
        [treeView(trace, code, h, messages), diffPane(task, code, h), sessionPane(task, code, h)],
      ),
    ],
  );
};
