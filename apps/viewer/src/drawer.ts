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
import { Array, DateTime, HashSet, Match, Option, Schema, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineRouteUnion, literal, mapTo, slash, string } from "foldkit/route";

import { shortSha } from "./codeView.ts";
import { Node, chainOf, judgmentsOf, nodeKeyOf, sectionTitleOf } from "./trace.ts";

// NOTE: the buttons here are native buttons with Type("button"). @foldkit/ui's Button.view adds
// only Tabindex(0) over that, so it is not a dependency.

/** The message constructors the drawer's view needs; the app supplies its own. */
export interface DrawerMessages<Message> {
  readonly onClose: Message;
  readonly onClickTask: (id: TaskId) => Message;
  /** "Open code" on a task, or a commit listed under it: the code view on that task. */
  readonly onOpenCode: (id: TaskId, maybeSha: Option.Option<Sha>) => Message;
}

/** The id of the open drawer's heading, which names the drawer and takes focus when it opens. */
export const DRAWER_HEADING_ID = "drawer-heading";

/** The server's routes the drawer links to. */
const ServerRoute = defineRouteUnion({ Session: { id: Schema.String } });

const sessionRouter = pipe(
  literal("api"),
  slash(literal("sessions")),
  slash(string("id")),
  mapTo(ServerRoute.Session),
);

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
  task: TraceTask,
  commit: TraceCommit,
  h: HtmlBuilder<Message>,
  messages: DrawerMessages<Message>,
): Html =>
  h.li(
    [],
    [
      h.button(
        [h.Type("button"), h.OnClick(messages.onOpenCode(task.id, Option.some(commit.sha)))],
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
    Array.map(task.commits, (commit) => commitView(task, commit, h, messages)),
  );

const sessionsView = <Message>(task: TraceTask, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.DataAttribute("drawer-part", "sessions")],
    [
      h.h3([], ["Sessions"]),
      h.ul(
        [],
        Array.map(task.sessions, (id) => h.li([], [h.a([h.Href(sessionRouter({ id }))], [id])])),
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
  h.button(
    [h.Type("button"), h.OnClick(messages.onOpenCode(task.id, Option.none()))],
    ["Open code"],
  ),
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
                  [h.Type("button"), h.OnClick(messages.onClickTask(task.id))],
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

/**
 * The drawer open on a node: a complementary landmark named by its heading, with a section's tasks (and a spec section's judgments),
 * or a task's "Open code" button, commits, sessions, events, gate reasons and judgments. A node the trace does not have opens a drawer titled by its id with nothing in it.
 * The drawer is keyed by its node, so no DOM state carries from one node's drawer to another's.
 */
export const drawerView = <Message>(
  trace: Trace,
  node: Node,
  h: HtmlBuilder<Message>,
  messages: DrawerMessages<Message>,
): Html => {
  const content = Node.match(node, {
    section: (section) => sectionContent(trace, section, h, messages),
    task: ({ id }) => taskContent(trace, id, h, messages),
  });

  return h.keyed("aside")(
    nodeKeyOf(node),
    [
      h.AriaLabelledBy(DRAWER_HEADING_ID),
      h.DataAttribute("drawer", node.kind),
      h.DataAttribute("drawer-id", node.id),
      // A panel over the right of the canvas with its own scroll: it does not push the page.
      h.Style({
        background: "#ffffff",
        "border-left": "1px solid #cbd5e1",
        bottom: "0",
        "box-shadow": "-4px 0 16px rgba(15, 23, 42, 0.15)",
        "box-sizing": "border-box",
        "max-width": "100vw",
        "overflow-y": "auto",
        padding: "12px 16px",
        position: "fixed",
        right: "0",
        top: "0",
        width: "420px",
        "z-index": "10",
      }),
    ],
    Array.flatten([
      [
        h.button([h.Type("button"), h.OnClick(messages.onClose)], ["Close"]),
        // Tabindex(-1): the heading takes focus when the drawer opens, but is not a tab stop.
        h.h2([h.Id(DRAWER_HEADING_ID), h.Tabindex(-1)], [content.title]),
      ],
      content.body,
    ]),
  );
};
