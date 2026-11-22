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
import { Array, DateTime, HashSet, Match, Option, Schema, String } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Node, chainOf, judgmentsOf } from "./trace.ts";

/** The message constructors the drawer's view needs; the app supplies its own. */
export interface DrawerMessages<M> {
  readonly onClose: M;
  readonly onClickTask: (id: TaskId) => M;
  readonly onClickCommit: (sha: Sha) => M;
}

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

const judgmentView = <M>(judgment: TraceJudgment, h: HtmlBuilder<M>): Html =>
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

const judgmentsView = <M>(trace: Trace, node: Node, h: HtmlBuilder<M>): Html =>
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

const commitView = <M>(commit: TraceCommit, h: HtmlBuilder<M>, messages: DrawerMessages<M>): Html =>
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

const commitsView = <M>(task: TraceTask, h: HtmlBuilder<M>, messages: DrawerMessages<M>): Html =>
  h.ul(
    [h.DataAttribute("drawer-part", "commits")],
    Array.map(task.commits, (commit) => commitView(commit, h, messages)),
  );

const taskDetailView = <M>(
  trace: Trace,
  task: TraceTask,
  h: HtmlBuilder<M>,
  messages: DrawerMessages<M>,
): ReadonlyArray<Html> => [
  h.section(
    [h.DataAttribute("drawer-part", "commits-section")],
    [h.h3([], ["Commits"]), commitsView(task, h, messages)],
  ),
  h.section(
    [h.DataAttribute("drawer-part", "sessions")],
    [
      h.h3([], ["Sessions"]),
      h.ul(
        [],
        Array.map(task.sessions, (id) =>
          h.li([], [h.a([h.DataAttribute("session", id), h.Href(`/api/sessions/${id}`)], [id])]),
        ),
      ),
    ],
  ),
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
  ),
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
  ),
  judgmentsView(trace, { id: task.id, kind: "task" }, h),
];

const sectionTasksView = <M>(
  trace: Trace,
  taskIds: HashSet.HashSet<string>,
  h: HtmlBuilder<M>,
  messages: DrawerMessages<M>,
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
            h.li(
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

/**
 * The drawer open on a node: a dialog with a section's tasks (and a spec section's judgments),
 * or a task's commits, sessions, events, gate reasons and judgments. A node the trace does not
 * have opens a dialog titled by its id with nothing in it.
 */
export const drawerView = <M>(
  trace: Trace,
  node: Node,
  h: HtmlBuilder<M>,
  messages: DrawerMessages<M>,
): Html => {
  const content = Node.match(node, {
    section: (section): DrawerContent => ({
      body: Array.appendAll(
        [sectionTasksView(trace, chainOf(trace, section).tasks, h, messages)],
        isSpecSection(section.id) ? [judgmentsView(trace, section, h)] : [],
      ),
      title: Option.getOrElse(
        Option.map(
          Array.findFirst(
            Array.appendAll(trace.prd.sections, trace.spec.sections),
            (candidate) => candidate.id === section.id,
          ),
          (found) => found.title,
        ),
        () => section.id,
      ),
    }),
    task: ({ id }): DrawerContent =>
      Option.match(
        Array.findFirst(trace.tasks, (candidate) => candidate.id === id),
        {
          onNone: () => ({ body: [], title: id }),
          onSome: (task) => ({
            body: taskDetailView(trace, task, h, messages),
            title: `${task.id} ${task.title}`,
          }),
        },
      ),
  });

  return h.aside(
    [
      h.Role("dialog"),
      h.AriaLabel(`Details for ${content.title}`),
      h.DataAttribute("drawer", node.kind),
      h.DataAttribute("drawer-id", node.id),
    ],
    Array.appendAll(
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
    ),
  );
};
