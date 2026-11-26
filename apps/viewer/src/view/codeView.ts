import type { Trace, TraceTask } from "@cairn/contract";
import type { Html } from "@effect/ui/html";
import { Array, Option, Record } from "effect";

import {
  commitsTo,
  patchPathOf,
  rangeOfCommits,
  shortSha,
  shownCommitOf,
  taskOf,
} from "../codeView.ts";
import { styleText } from "../effect-ui/attributes.ts";
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
  h: Html.H<Message>,
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  diffStyle: DiffStyle,
  copy: CopyLinks,
  messages: CodeMessages,
) =>
  h.header
    .class("topbar")
    .attr("data-code-bar", "")
    .children(
      h.button
        .attr("type", "button")
        .class("btn")
        .on("click", messages.onBack)
        .children("Back to the plan"),
      Option.match(task, {
        onNone: () => h.span.attr("role", "alert").children(`No task ${code.taskId} in the trace.`),
        onSome: (found) => [
          h.h1(`${found.id} ${found.branch}`),
          h.span.attr("data-shown", "").children(shownText(found, code.shown)),
        ],
      }),
      // The whole path, and the last step on its own: the lines, the file, the diff or the commit.
      Array.map(Array.fromOption(copy.maybeWhole), (path) =>
        copyButtonView(h, copy.maybeCopied, path, "Copy link"),
      ),
      Array.map(Array.fromOption(copy.maybeAlone), (path) =>
        copyButtonView(h, copy.maybeCopied, path, "Copy alone"),
      ),
      diffStyleToggleView(h, diffStyle, messages.onDiffStyle),
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
  h: Html.H<Message>,
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  patches: Record.ReadonlyRecord<string, PatchData>,
  diffStyle: DiffStyle,
  marks: DiffMarks,
) =>
  h.section
    .class("code-pane")
    .attr("aria-label", "Diff")
    .attr("data-code-pane", "diff")
    .attr("style", styleText(diffPaneStyle))
    .children(
      Option.match(task, {
        onNone: () => h.p("This task is not in the trace."),
        onSome: (found) =>
          Option.match(patchPathOf(found, code.shown), {
            onNone: () =>
              h.p(
                Array.isReadonlyArrayEmpty(found.commits)
                  ? "This task has no commits."
                  : "This task has no diff to show.",
              ),
            onSome: (path) => patchView(h, patches, path, diffStyle, code.maybeFile, marks),
          }),
      }),
    );

/** The right pane: the session of the selected commit, or of a whole task's latest commit. */
const sessionPane = (
  h: Html.H<Message>,
  task: Option.Option<TraceTask>,
  code: CodeScreen,
  state: SessionState,
  copy: CopyLinks,
  messages: SessionMessages,
) =>
  h.aside
    .class("code-pane")
    .attr("aria-label", "Session")
    .attr("data-code-pane", "session")
    // The width is the pane's own; the scroll stays with it.
    .attr("style", styleText({ "overflow-y": "auto", width: SESSION_WIDTH }))
    .children(
      Option.match(
        Option.flatMap(task, (found) => shownCommitOf(found, code.shown)),
        {
          onNone: () => h.p("No session: there is no commit."),
          onSome: (commit) =>
            sessionView(h, Option.fromNullOr(commit.session), state, copy, messages),
        },
      ),
    );

/**
 * The code view: the whole window under a top bar, in three panes. The tree and the session each
 * scroll on their own; the diff takes the rest.
 */
export const codeView = (
  h: Html.H<Message>,
  trace: Trace,
  code: CodeScreen,
  patches: Record.ReadonlyRecord<string, PatchData>,
  diffStyle: DiffStyle,
  state: SessionState,
  maybeNotice: Option.Option<string>,
  copy: CopyLinks,
  messages: CodeMessages,
) => {
  const task = taskOf(trace, code.taskId);
  return h.div
    .class("code-screen")
    .attr("data-code-view", code.taskId)
    .children(
      barView(h, task, code, diffStyle, copy, messages),
      Option.getOrUndefined(
        Option.map(maybeNotice, (text) =>
          linkNoticeView(h, text, { onDismiss: messages.onDismissNotice }),
        ),
      ),
      h.div
        .key("code-body")
        .class("code-body")
        .children(
          treeView(h, trace, code, messages),
          diffPane(h, task, code, patches, diffStyle, marksOf(task, code, state)),
          sessionPane(h, task, code, state, copy, messages),
        ),
    );
};
