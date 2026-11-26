import type { Trace, TraceTask } from "@cairn/contract";
import { Array, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  commitsTo,
  patchPathOf,
  rangeOfCommits,
  shortSha,
  shownCommitOf,
  taskOf,
} from "../codeView.ts";
import type { CopyLinks } from "../links.ts";
import type { Message } from "../message.ts";
import { Shown, type CodeScreen, type DiffStyle, type PatchData } from "../model.ts";
import { copyButtonView } from "./copyLinkView.ts";
import { linkNoticeView } from "./linkNoticeView.ts";
import { diffStyleToggleView, patchView, type DiffMarks } from "./diffView.ts";
import {
  loadedSessionOf,
  sessionView,
  type SessionMessages,
  type SessionState,
} from "./sessionView.ts";
import { treeView, type TreeMessages } from "./treeView.ts";

/**
 * The message constructors the code view's view needs; the app supplies its own. The diff view
 * mounts a Mount that sends the app's own Message, so unlike the tree the code view is not generic.
 */
export interface CodeMessages extends TreeMessages<Message>, SessionMessages {
  readonly onDismissNotice: Message;
  readonly onBack: Message;
  readonly onDiffStyle: (style: DiffStyle) => Message;
}

/** The session pane's width; the tree has its own and the diff takes the rest. */
const SESSION_WIDTH = "420px";

/**
 * The diff pane does not scroll: the list the mount draws scrolls inside it and fills it. The
 * notes in it (loading, failed, no commits) carry their own padding, from the stylesheet.
 */
const diffPaneStyle = {
  display: "flex",
  flex: "1",
  "flex-direction": "column",
  "min-height": "0",
  "min-width": "0",
};

const plural = (count: number): string => (count === 1 ? "1 commit" : `${count} commits`);

/**
 * What the bar says is shown: a whole task's commit count and range, or one commit. A whole task
 * shown at an older head counts and ranges the commits up to that head, as its diff does.
 */
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
    WholeTask: ({ maybeHead }) => {
      const commits = commitsTo(task, maybeHead);
      return Option.match(rangeOfCommits(commits), {
        onNone: () => plural(Array.length(commits)),
        onSome: ({ base, head }) =>
          `${plural(Array.length(commits))} ${shortSha(base)}..${shortSha(head)}`,
      });
    },
  });

const barView = (
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  diffStyle: DiffStyle,
  copy: CopyLinks,
  h: HtmlBuilder<Message>,
  messages: CodeMessages,
): Html =>
  h.header(
    [h.Class("topbar"), h.DataAttribute("code-bar", "")],
    Array.prepend(
      Array.append(
        Array.appendAll(
          Option.match(task, {
            onNone: () => [h.span([h.Role("alert")], [`No task ${code.taskId} in the trace.`])],
            onSome: (found) => [
              h.h1([], [`${found.id} ${found.branch}`]),
              h.span([h.DataAttribute("shown", "")], [shownText(found, code.shown)]),
            ],
          }),
          // The whole path, and the last step on its own: the lines, the file, the diff or the commit.
          Array.flatten([
            Array.map(Array.fromOption(copy.maybeWhole), (path) =>
              copyButtonView(copy.maybeCopied, path, "Copy link", h),
            ),
            Array.map(Array.fromOption(copy.maybeAlone), (path) =>
              copyButtonView(copy.maybeCopied, path, "Copy alone", h),
            ),
          ]),
        ),
        diffStyleToggleView(diffStyle, messages.onDiffStyle, h),
      ),
      h.button(
        [h.Type("button"), h.Class("btn"), h.OnClick(messages.onBack)],
        ["Back to the plan"],
      ),
    ),
  );

/** The session the right pane shows, once it is read, and the turn highlighted in it. */
const marksOf = (
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  state: SessionState,
): DiffMarks => ({
  maybeLines: code.maybeLines,
  maybeSession: Option.flatMap(
    Option.flatMapNullishOr(
      Option.flatMap(task, (found) => shownCommitOf(found, code.shown)),
      (commit) => commit.session,
    ),
    (id) => loadedSessionOf(state, id),
  ),
  maybeTurn: state.maybeHighlightedTurn,
});

/** The middle pane: where the diff for what is shown will be drawn, or why there is none. */
const diffPane = (
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  patches: Record<string, PatchData>,
  diffStyle: DiffStyle,
  marks: DiffMarks,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.Class("code-pane"),
      h.AriaLabel("Diff"),
      h.DataAttribute("code-pane", "diff"),
      h.Style(diffPaneStyle),
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
            onSome: (path) => patchView(patches, path, diffStyle, code.maybeFile, h, marks),
          }),
      }),
    ],
  );

/** The right pane: the session of the selected commit, or of a whole task's latest commit. */
const sessionPane = (
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  state: SessionState,
  copy: CopyLinks,
  h: HtmlBuilder<Message>,
  messages: SessionMessages,
): Html =>
  h.aside(
    [
      h.Class("code-pane"),
      h.AriaLabel("Session"),
      h.DataAttribute("code-pane", "session"),
      // The width is the pane's own; the scroll stays with it.
      h.Style({ "overflow-y": "auto", width: SESSION_WIDTH }),
    ],
    [
      Option.match(
        Option.flatMap(task, (found) => shownCommitOf(found, code.shown)),
        {
          onNone: () => h.p([], ["No session: there is no commit."]),
          onSome: (commit) =>
            sessionView(Option.fromNullOr(commit.session), state, copy, h, messages),
        },
      ),
    ],
  );

/**
 * The code view: the whole window under a top bar, in three panes. The tree and the session each
 * scroll on their own; the diff takes the rest.
 */
export const codeView = (
  trace: Trace,
  code: CodeScreen,
  patches: Record<string, PatchData>,
  diffStyle: DiffStyle,
  state: SessionState,
  maybeNotice: Option.Option<string>,
  copy: CopyLinks,
  h: HtmlBuilder<Message>,
  messages: CodeMessages,
): Html => {
  const task = taskOf(trace, code.taskId);
  return h.div(
    [h.Class("code-screen"), h.DataAttribute("code-view", code.taskId)],
    Array.appendAll(
      Array.prepend(
        Option.match(maybeNotice, {
          onNone: () => [],
          onSome: (text) => [linkNoticeView(text, h, { onDismiss: messages.onDismissNotice })],
        }),
        barView(task, code, diffStyle, copy, h, messages),
      ),
      [
        h.div(
          [h.Class("code-body")],
          [
            treeView(trace, code, h, messages),
            diffPane(task, code, patches, diffStyle, marksOf(task, code, state), h),
            sessionPane(task, code, state, copy, h, messages),
          ],
        ),
      ],
    ),
  );
};
