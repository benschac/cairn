import {
  ProbabilityAnswer,
  RateAnswer,
  SpecSectionId,
  Unanswered,
  type Sha,
  type TaskId,
  type Trace,
  type TraceCommit,
  type TraceJudgment,
  type TraceTask,
} from "@cairn/contract";
import { Array, DateTime, HashSet, Match, Option, Schema, String, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineRouteUnion, literal, mapTo, slash, string } from "foldkit/route";

import { Node, chainOf, judgmentsOf, sectionTitleOf } from "./trace.ts";

/** The message constructors the drawer's view needs; the app supplies its own. */
export interface DrawerMessages<Message> {
  readonly onClose: Message;
  readonly onClickTask: (id: TaskId) => Message;
  readonly onClickCommit: (sha: Sha) => Message;
}

/** The server's routes the drawer links to. */
const ServerRoute = defineRouteUnion({ Session: { id: Schema.String } });

const sessionRouter = pipe(
  literal("api"),
  slash(literal("sessions")),
  slash(string("id")),
  mapTo(ServerRoute.Session),
);

const shortSha = (sha: Sha): string => String.takeLeft(sha, 7);

const isSpecSection = Schema.is(SpecSectionId);

const answerText = Match.type<TraceJudgment["answer"]>().pipe(
  Match.when(Schema.is(ProbabilityAnswer), (answer) => `probability ${answer.probability}`),
  Match.when(Schema.is(Unanswered), (answer) => `${answer.unanswered}: ${answer.description}`),
  Match.when(Schema.is(RateAnswer), (answer) =>
    Option.match(Option.fromUndefinedOr(answer.confidence), {
      onNone: () => answer.label,
      onSome: (confidence) => `${answer.label} (confidence ${confidence})`,
    }),
  ),
  Match.exhaustive,
);

const gateText = (required: boolean): string => (required ? "human required" : "no human gate");

const judgmentView = <Message>(judgment: TraceJudgment, h: HtmlBuilder<Message>): Html =>
  h.li(
    [
      h.DataAttribute("drawer-judgment", judgment.question),
      h.DataAttribute("verdict", judgment.verdict),
      h.DataAttribute("stale", `${judgment.stale}`),
    ],
    [
      h.strong([], [judgment.question]),
      ` ${judgment.verdict}${judgment.stale ? " (stale)" : ""}: ${judgment.message} `,
      h.span([h.DataAttribute("answer", "")], [answerText(judgment.answer)]),
    ],
  );

const judgmentsView = <Message>(trace: Trace, node: Node, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.DataAttribute("drawer-part", "judgments")],
    [
      h.h3([], ["Judgments"]),
      h.ul(
        [],
        Array.map(judgmentsOf(trace, node), (judgment) => judgmentView(judgment, h)),
      ),
    ],
  );

const commitView = <Message>(
  commit: TraceCommit,
  h: HtmlBuilder<Message>,
  messages: DrawerMessages<Message>,
): Html =>
  h.li(
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("commit", commit.sha),
          h.OnClick(messages.onClickCommit(commit.sha)),
        ],
        [`${commit.subject} ${shortSha(commit.sha)}`],
      ),
    ],
  );

const commitsView = <Message>(
  task: TraceTask,
  h: HtmlBuilder<Message>,
  messages: DrawerMessages<Message>,
): Html =>
  h.ul(
    [h.DataAttribute("drawer-part", "commits")],
    Array.map(task.commits, (commit) => commitView(commit, h, messages)),
  );

const sessionsView = <Message>(task: TraceTask, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.DataAttribute("drawer-part", "sessions")],
    [
      h.h3([], ["Sessions"]),
      h.ul(
        [],
        Array.map(task.sessions, (id) =>
          h.li([], [h.a([h.DataAttribute("session", id), h.Href(sessionRouter({ id }))], [id])]),
        ),
      ),
    ],
  );

const eventsView = <Message>(task: TraceTask, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.DataAttribute("drawer-part", "events")],
    [
      h.h3([], ["Events"]),
      h.ol(
        [],
        Array.map(task.events, (event) =>
          h.li(
            [h.DataAttribute("event", event.status)],
            [`${event.status} ${DateTime.formatIso(event.ts)} ${event.actor}`],
          ),
        ),
      ),
    ],
  );

/** The gate the plan set and the gate in effect, each with its reasons. */
const gateView = <Message>(task: TraceTask, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.DataAttribute("drawer-part", "gate")],
    [
      h.h3([], ["Gate"]),
      h.div(
        [h.DataAttribute("gate-source", "humanGate")],
        [`Planned: ${gateText(task.humanGate.required)}`],
      ),
      h.ul(
        [h.DataAttribute("gate-reasons", "humanGate")],
        Array.map(task.humanGate.reasons, (reason) => h.li([], [reason])),
      ),
      h.div(
        [h.DataAttribute("gate-source", "effective")],
        [`Effective: ${gateText(task.gate.required)}`],
      ),
      h.ul(
        [h.DataAttribute("gate-reasons", "effective")],
        Array.map(task.gate.reasons, (reason) => h.li([], [reason])),
      ),
    ],
  );

const taskDetailView = <Message>(
  trace: Trace,
  task: TraceTask,
  h: HtmlBuilder<Message>,
  messages: DrawerMessages<Message>,
): ReadonlyArray<Html> => [
  h.section(
    [h.DataAttribute("drawer-part", "commits-section")],
    [h.h3([], ["Commits"]), commitsView(task, h, messages)],
  ),
  sessionsView(task, h),
  eventsView(task, h),
  gateView(task, h),
  judgmentsView(trace, { id: task.id, kind: "task" }, h),
];

const sectionTasksView = <Message>(
  trace: Trace,
  taskIds: HashSet.HashSet<string>,
  h: HtmlBuilder<Message>,
  messages: DrawerMessages<Message>,
): Html =>
  h.section(
    [h.DataAttribute("drawer-part", "tasks")],
    [
      h.h3([], ["Tasks"]),
      h.ul(
        [],
        Array.map(
          Array.filter(trace.tasks, (task) => HashSet.has(taskIds, task.id)),
          (task) =>
            h.keyed("li")(
              task.id,
              [h.DataAttribute("drawer-task", task.id)],
              [
                h.button(
                  [
                    h.Type("button"),
                    h.DataAttribute("open-task", task.id),
                    h.OnClick(messages.onClickTask(task.id)),
                  ],
                  [`${task.id} ${task.title}`],
                ),
                commitsView(task, h, messages),
              ],
            ),
        ),
      ),
    ],
  );

interface DrawerContent {
  readonly title: string;
  readonly body: ReadonlyArray<Html>;
}

/** A section's tasks and, for a spec section, its judgments. */
const sectionContent = <Message>(
  trace: Trace,
  section: typeof Node.cases.section.Type,
  h: HtmlBuilder<Message>,
  messages: DrawerMessages<Message>,
): DrawerContent => ({
  body: Array.appendAll(
    [sectionTasksView(trace, chainOf(trace, section).tasks, h, messages)],
    isSpecSection(section.id) ? [judgmentsView(trace, section, h)] : [],
  ),
  title: sectionTitleOf(trace, section.id),
});

/** A task's detail, or nothing under its id when the trace does not have it. */
const taskContent = <Message>(
  trace: Trace,
  id: TaskId,
  h: HtmlBuilder<Message>,
  messages: DrawerMessages<Message>,
): DrawerContent =>
  Option.match(
    Array.findFirst(trace.tasks, (candidate) => candidate.id === id),
    {
      onNone: () => ({ body: [], title: id }),
      onSome: (task) => ({
        body: taskDetailView(trace, task, h, messages),
        title: `${task.id} ${task.title}`,
      }),
    },
  );

/** In the demo the commit is already in the trace, so its detail is its subject and files. */
const commitDetailView = <Message>(
  trace: Trace,
  sha: Sha,
  h: HtmlBuilder<Message>,
): Option.Option<Html> =>
  Option.map(
    Array.findFirst(
      Array.flatMap(trace.tasks, (task) => task.commits),
      (commit) => commit.sha === sha,
    ),
    (commit) =>
      h.section(
        [h.DataAttribute("commit-detail", commit.sha)],
        [
          h.h3([], [commit.subject]),
          h.ul(
            [],
            Array.map(commit.files, (file) => h.li([], [file])),
          ),
        ],
      ),
  );

/**
 * The drawer open on a node: a dialog with a section's tasks (and a spec section's judgments),
 * or a task's commits, sessions, events, gate reasons and judgments, and last the commit clicked
 * in it. A node the trace does not have opens a dialog titled by its id with nothing in it.
 * The drawer is keyed by its node, so no DOM state carries from one node's drawer to another's.
 */
export const drawerView = <Message>(
  trace: Trace,
  node: Node,
  maybeCommitSha: Option.Option<Sha>,
  h: HtmlBuilder<Message>,
  messages: DrawerMessages<Message>,
): Html => {
  const content = Node.match(node, {
    section: (section) => sectionContent(trace, section, h, messages),
    task: ({ id }) => taskContent(trace, id, h, messages),
  });

  return h.keyed("aside")(
    `${node.kind}:${node.id}`,
    [
      h.Role("dialog"),
      h.AriaLabel(`Details for ${content.title}`),
      h.DataAttribute("drawer", node.kind),
      h.DataAttribute("drawer-id", node.id),
    ],
    Array.flatten([
      [
        h.button(
          [
            h.Type("button"),
            h.AriaLabel("Close"),
            h.DataAttribute("close", ""),
            h.OnClick(messages.onClose),
          ],
          ["Close"],
        ),
        h.h2([], [content.title]),
      ],
      content.body,
      Array.fromOption(Option.flatMap(maybeCommitSha, (sha) => commitDetailView(trace, sha, h))),
    ]),
  );
};
