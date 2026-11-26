import {
  ProbabilityAnswer,
  RateAnswer,
  SectionId,
  Unanswered,
  type Trace,
  type TraceJudgment,
  type TraceSection,
  type TraceTask,
} from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Array, DateTime, Match, Option, Record, Result, Schema, String } from "effect";

import { DETAIL_HEADING_ID, type Trail } from "../detail.ts";
import { filesOf, patchPathOf, shortSha } from "../codeView.ts";
import { styleText } from "../effect-ui/attributes.ts";
import { trailStepOf, pathOfLink } from "../links.ts";
import { Message } from "../message.ts";
import { WHOLE_TASK, type DiffStyle, type PatchData } from "../model.ts";
import { ranOf, statusWordOf } from "../reader.ts";
import { Node, judgmentsOf, nodeKeyOf, sectionTitleOf } from "../trace.ts";
import { dotView, labelView, tagView } from "../ui/marks.ts";
import { copyButtonView } from "./copyLinkView.ts";
import { patchView } from "./diffView.ts";
import { dividerView, handleWidthOf } from "./dividerView.ts";
import type { Widths } from "../panes.ts";

/** The content's side padding: more than half the resize handle, which overlaps it. */
export const DETAIL_PADDING = 16;

// NOTE: the buttons here are native buttons with type="button".

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

const judgmentView = (h: Html.H<Message>, judgment: TraceJudgment) =>
  h.li
    .attr("data-drawer-judgment", judgment.question)
    .attr("data-verdict", judgment.verdict)
    .attr("data-stale", `${judgment.stale}`)
    .children(
      h.strong(judgment.question),
      ` ${judgment.verdict}${judgment.stale ? " (stale)" : ""}: ${judgment.message} `,
      h.span.attr("data-answer", "").children(answerText(judgment.answer)),
    );

export const judgmentsView = (h: Html.H<Message>, trace: Trace, node: Node) =>
  h.section
    .attr("data-drawer-part", "judgments")
    .children(
      h.h3("Judgments"),
      h.ul(Array.map(judgmentsOf(trace, node), (judgment) => judgmentView(h, judgment))),
    );

export const eventsView = (h: Html.H<Message>, task: TraceTask) =>
  h.section
    .attr("data-drawer-part", "events")
    .children(
      h.h3("Events"),
      h.ol(
        Array.map(task.events, (event) =>
          h.li
            .attr("data-event", event.status)
            .children(`${event.status} ${DateTime.formatIso(event.ts)} ${event.actor}`),
        ),
      ),
    );

/** The gate the plan set and the gate in effect, each with its reasons. */
export const gateView = (h: Html.H<Message>, task: TraceTask) =>
  h.section
    .attr("data-drawer-part", "gate")
    .children(
      h.h3("Gate"),
      h.div
        .attr("data-gate-source", "humanGate")
        .children(`Planned: ${gateText(task.humanGate.required)}`),
      h.ul
        .attr("data-gate-reasons", "humanGate")
        .children(Array.map(task.humanGate.reasons, (reason) => h.li(reason))),
      h.div
        .attr("data-gate-source", "effective")
        .children(`Effective: ${gateText(task.gate.required)}`),
      h.ul
        .attr("data-gate-reasons", "effective")
        .children(Array.map(task.gate.reasons, (reason) => h.li(reason))),
    );

const taskNode = (id: TraceTask["id"]): Node => ({ id, kind: "task" });
const sectionIdOf = (id: string): SectionId => SectionId.make(id);
const sectionNode = (id: string): Node => ({ id: sectionIdOf(id), kind: "section" });

/** A button that adds a node to the trail. */
const addButton = (h: Html.H<Message>, label: string, node: Node) =>
  h.button
    .attr("type", "button")
    .class("btn")
    .attr("data-detail-add", nodeKeyOf(node))
    .on("click", Message.ClickedDetailNode({ node }))
    .children(label);

const partView = (h: Html.H<Message>, part: string, heading: string, body: View.Input<Message>) =>
  h.section
    .attr("data-detail-part", part)
    .attr("style", styleText({ "margin-top": "16px" }))
    .children(labelView(h, heading), body);

/** What a trail step reads: a task by its ID, a spec section by its title. */
const stepLabelOf = (trace: Trace, node: Node): string =>
  Node.match(node, {
    section: ({ id }) => sectionTitleOf(trace, id),
    task: ({ id }) => id,
  });

/**
 * What the panel's Copy link buttons need: the path last copied, and for each step of the trail the
 * link up to that step.
 */
export interface DetailCopy {
  readonly maybeCopied: Option.Option<string>;
  readonly trailPaths: ReadonlyArray<string>;
}

/** The trail across the panel's top, with the button that closes the panel. */
const trailView = (h: Html.H<Message>, trace: Trace, trail: Trail, copy: DetailCopy) =>
  h.div
    .attr(
      "style",
      styleText({
        "align-items": "center",
        display: "flex",
        gap: "6px",
        "justify-content": "space-between",
      }),
    )
    .children(
      h.nav
        .attr("aria-label", "Trail")
        .attr("data-detail-trail", "")
        .attr(
          "style",
          styleText({ display: "flex", "flex-wrap": "wrap", gap: "6px", "min-width": "0" }),
        )
        .children(
          Array.flatMap(trail, (node, index) =>
            Array.prepend(
              Array.map(Array.fromOption(Array.get(copy.trailPaths, index)), (path) =>
                copyButtonView(h, copy.maybeCopied, path, "Copy link"),
              ),
              h.button
                .attr("type", "button")
                .class("btn")
                .attr("data-trail-step", `${index}`)
                .on("click", Message.ClickedTrailStep({ index }))
                .attr("aria-current", index === Array.length(trail) - 1 ? "step" : undefined)
                .children(stepLabelOf(trace, node)),
            ),
          ),
        ),
      h.button
        .attr("type", "button")
        .class("btn")
        .attr("data-detail-close", "")
        .on("click", Message.ClickedCloseDetail())
        .children("Close"),
    );

// The heading takes focus when the panel opens or its node changes, but is not a tab stop.
const headingView = (h: Html.H<Message>, title: string) =>
  h.h2.id(DETAIL_HEADING_ID).attr("tabindex", "-1").children(title);

const commitsView = (h: Html.H<Message>, task: TraceTask) =>
  partView(h, "commits", "Commits", [
    h.ul(
      Array.map(task.commits, (commit) =>
        h.li(
          h.button
            .attr("type", "button")
            .class("btn")
            .attr("data-detail-commit", commit.sha)
            .on(
              "click",
              Message.ClickedOpenCode({ id: task.id, maybeSha: Option.some(commit.sha) }),
            )
            .children(`${commit.subject} ${shortSha(commit.sha)}`),
        ),
      ),
    ),
    h.button
      .attr("type", "button")
      .class("btn")
      .attr("data-detail-open-code", "")
      .on("click", Message.ClickedOpenCode({ id: task.id, maybeSha: Option.none() }))
      .children("Open in code view"),
  ]);

const codeNoteOf = (task: TraceTask): string =>
  task.status === "done" || task.status === "landed"
    ? "No commit carries this task's Cairn-Task trailer."
    : "No code yet. The task has not started.";

const countText = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The task's whole stacked diff, drawn by the mount the code view uses. The list scrolls itself,
 * so it sits in a region of 60% of the window's height, under the commit and file counts.
 */
const codePartView = (
  h: Html.H<Message>,
  task: TraceTask,
  patches: Record.ReadonlyRecord<string, PatchData>,
  diffStyle: DiffStyle,
) =>
  partView(
    h,
    "code",
    "Code",
    Array.match(task.commits, {
      onEmpty: () => [h.p.attr("data-detail-code-note", "").children(codeNoteOf(task))],
      onNonEmpty: (commits) => [
        h.p
          .attr("data-detail-code-summary", "")
          .children(
            `${countText(Array.length(commits), "commit")} · ${countText(Array.length(filesOf(task, WHOLE_TASK)), "file")} changed`,
          ),
        Option.match(patchPathOf(task, WHOLE_TASK), {
          onNone: () => h.p("This task has no diff to show."),
          onSome: (path) =>
            h.div
              .attr("data-detail-code", "")
              .attr(
                "style",
                styleText({ display: "flex", "flex-direction": "column", height: "60vh" }),
              )
              .children(patchView(h, patches, path, diffStyle, Option.none())),
        }),
      ],
    }),
  );

const tracesView = (h: Html.H<Message>, trace: Trace, task: TraceTask) =>
  partView(
    h,
    "traces",
    "Traces to",
    h.ul(
      Array.appendAll(
        Array.map(task.prdSections, (id) =>
          h.li(
            h.button
              .attr("type", "button")
              .class("btn")
              .attr("data-detail-prd", id)
              .on("click", Message.ClickedTraceSection({ id }))
              .children(sectionTitleOf(trace, sectionIdOf(id))),
          ),
        ),
        Array.map(task.specSections, (id) =>
          h.li(addButton(h, sectionTitleOf(trace, sectionIdOf(id)), sectionNode(id))),
        ),
      ),
    ),
  );

/**
 * Whether a human has approved the task: it is past the gate (done or landed) and its events hold a
 * `done` written by a `human:` actor. A human `done` that only finished a gated task leaves it
 * blocked_on_human, so it does not count.
 */
const approvedByHuman = (task: TraceTask): boolean =>
  (task.status === "done" || task.status === "landed") &&
  Array.some(
    task.events,
    (event) => event.status === "done" && String.startsWith("human:")(event.actor),
  );

/**
 * The statements the task carries, found in the PRD by ID. While the task waits on a human they
 * are a checklist with the human-tagged ones first; once a human approved, those show as settled.
 */
const doneWhenView = (h: Html.H<Message>, trace: Trace, task: TraceTask) => {
  const carried = Array.flatMap(task.statements, (id) =>
    Array.fromOption(Array.findFirst(trace.prd.statements, (statement) => statement.id === id)),
  );
  const reviewing = task.status === "blocked_on_human";
  const approved = approvedByHuman(task);
  const shown = reviewing
    ? Array.appendAll(
        Array.filter(carried, (statement) => statement.human),
        Array.filter(carried, (statement) => !statement.human),
      )
    : carried;
  return Array.match(shown, {
    onEmpty: () => [],
    onNonEmpty: (statements) => [
      partView(
        h,
        "done-when",
        "Done when",
        h.ul(
          Array.map(statements, (statement) => {
            const settled = statement.human && approved;
            return h.li
              .key(statement.id)
              .attr("data-done-when-statement", statement.id)
              .attr("data-settled", settled ? "" : undefined)
              .children(
                reviewing || settled ? (settled ? "[x] " : "[ ] ") : undefined,
                statement.draft
                  ? [h.span.class("chip").attr("data-draft", "").children("Draft"), " "]
                  : undefined,
                statement.text,
              );
          }),
        ),
      ),
    ],
  });
};

/** "on t52" for a parent, "from main" for none. */
const parentText = (task: TraceTask): string =>
  Option.match(Option.fromNullOr(task.parent), {
    onNone: () => "from main",
    onSome: (parent) => `on ${parent}`,
  });

const stackNumberOf = (trace: Trace, task: TraceTask): Option.Option<number> =>
  Option.map(
    Array.findFirst(stacksOf(trace.tasks), (stack) => Record.has(stack.cells, task.id)),
    (stack) => stack.number,
  );

const taskView = (
  h: Html.H<Message>,
  trace: Trace,
  task: TraceTask,
  patches: Record.ReadonlyRecord<string, PatchData>,
  diffStyle: DiffStyle,
): View.Children<Message, never> => {
  const ran = ranOf(task);
  const others = Array.filter(task.dependsOn, (id) => id !== task.parent);
  return Array.flatten([
    [
      headingView(h, `${task.id} ${task.title}`),
      h.p.attr("data-detail-part", "where").children(
        tagView(h, "task", task.id),
        ` ${task.branch}`,
        Array.map(Array.fromOption(stackNumberOf(trace, task)), (number) => ` · Stack ${number}`),
      ),
      h.div.attr("data-detail-part", "facts").children(
        h.p(dotView(h, task.status), ` ${statusWordOf(task.status)}`),
        h.p
          .attr("data-detail-ran", "")
          .children(`${ran.ran ? "ran on" : "planned for"} ${ran.model} · ${ran.reasoning}`),
        h.p.attr("data-detail-parent", "").children(parentText(task)),
        Array.isReadonlyArrayNonEmpty(others) &&
          h.p.attr("data-detail-depends", "").children(
            "Depends on ",
            Array.map(others, (id) => addButton(h, id, taskNode(id))),
          ),
      ),
    ],
    doneWhenView(h, trace, task),
    [
      task.gate.required && gateView(h, task),
      commitsView(h, task),
      codePartView(h, task, patches, diffStyle),
      tracesView(h, trace, task),
      partView(
        h,
        "files",
        "Files the plan expects",
        h.ul(Array.map(task.files, (file) => h.li(h.code(file)))),
      ),
      eventsView(h, task),
      judgmentsView(h, trace, taskNode(task.id)),
    ],
  ]);
};

const keysView = (h: Html.H<Message>, section: TraceSection) =>
  h.div
    .attr("data-detail-part", "keys")
    .attr("style", styleText({ display: "flex", "flex-wrap": "wrap", gap: "6px" }))
    .children(
      Array.flatMap(
        [
          ["Implements", section.keys.implements],
          ["Files", section.keys.files],
          ["Depends on", section.keys.dependsOn],
          ["Defers", section.keys.defers],
          ["Context", section.keys.context],
        ] as const,
        ([key, values]) =>
          Array.map(values, (value) =>
            h.span.class("chip").attr("data-detail-key", key).children(`${key}: ${value}`),
          ),
      ),
    );

const sectionView = (
  h: Html.H<Message>,
  trace: Trace,
  id: string,
): View.Children<Message, never> => {
  const maybeSection = Array.findFirst(trace.spec.sections, (section) => section.id === id);
  const tasks = Array.filter(trace.tasks, (task) =>
    Array.some(task.specSections, (each) => each === id),
  );
  return Array.flatten([
    [headingView(h, sectionTitleOf(trace, sectionIdOf(id))), h.p(tagView(h, "spec", id))],
    Array.flatMap(Array.fromOption(maybeSection), (section) =>
      Array.appendAll(
        Array.map(Array.fromNullishOr(section.summary), (summary) =>
          h.p.attr("data-detail-part", "summary").children(summary),
        ),
        [keysView(h, section)],
      ),
    ),
    [
      partView(
        h,
        "tasks",
        "Tasks",
        h.ul(
          Array.map(tasks, (task) =>
            h.li.key(task.id).children(addButton(h, `${task.id} ${task.title}`, taskNode(task.id))),
          ),
        ),
      ),
      judgmentsView(h, trace, sectionNode(id)),
    ],
  ]);
};

/** What the last node of the trail shows. A task the trace does not have shows its ID and nothing else. */
const bodyOf = (
  h: Html.H<Message>,
  trace: Trace,
  node: Node,
  patches: Record.ReadonlyRecord<string, PatchData>,
  diffStyle: DiffStyle,
): View.Children<Message, never> =>
  Node.match(node, {
    section: ({ id }) => sectionView(h, trace, id),
    task: ({ id }) =>
      Option.match(
        Array.findFirst(trace.tasks, (task) => task.id === id),
        {
          onNone: () => [headingView(h, id)],
          onSome: (task) => taskView(h, trace, task, patches, diffStyle),
        },
      ),
  });

/**
 * The panel's body: the heading, then a Copy link for its task or spec section alone, then the
 * rest.
 */
const withHeadingCopy = (
  h: Html.H<Message>,
  body: View.Children<Message, never>,
  node: Node,
  maybeCopied: Option.Option<string>,
): View.Children<Message, never> =>
  Array.matchLeft(body, {
    onEmpty: () => [],
    onNonEmpty: (heading, rest) =>
      Array.prepend(
        Array.prependAll(
          rest,
          Array.map(Array.fromOption(Result.getSuccess(trailStepOf(node))), (step) =>
            copyButtonView(h, maybeCopied, pathOfLink([step]), "Copy link"),
          ),
        ),
        heading,
      ),
  });

/**
 * The detail panel: fixed to the right edge of the reader, full height, with its own scroll and a
 * divider on its left edge. It lies over the panes and moves none of them. The trail runs across
 * its top; the last node is shown under it. The part that scrolls is keyed by the node, so no DOM
 * state carries from one step to another.
 */
export const detailView = (
  h: Html.H<Message>,
  trace: Trace,
  trail: Trail & Array.NonEmptyReadonlyArray<Node>,
  widths: Widths,
  patches: Record.ReadonlyRecord<string, PatchData>,
  diffStyle: DiffStyle,
  copy: DetailCopy,
) => {
  const node = Array.lastNonEmpty(trail);
  return h.aside
    .attr("aria-labelledby", DETAIL_HEADING_ID)
    .class("panel")
    .attr("data-detail", node.kind)
    .attr("data-detail-id", node.id)
    .attr(
      "style",
      styleText({
        bottom: "0",
        "box-sizing": "border-box",
        "max-width": "100vw",
        position: "fixed",
        right: "0",
        top: "0",
        width: `${widths.detail}px`,
        "z-index": "10",
      }),
    )
    .children(
      // The handle is centred on the panel's left edge, and is narrower than the content's padding.
      h.div
        .attr("data-detail-handle", "")
        .attr(
          "style",
          styleText({
            bottom: "0",
            display: "grid",
            left: `-${handleWidthOf("detail") / 2}px`,
            position: "absolute",
            top: "0",
          }),
        )
        .children(dividerView(h, "detail", widths)),
      h.div
        .key(nodeKeyOf(node))
        .attr("data-detail-content", "")
        .attr(
          "style",
          styleText({
            "box-sizing": "border-box",
            height: "100%",
            "overflow-y": "auto",
            padding: `12px ${DETAIL_PADDING}px`,
          }),
        )
        .children(
          trailView(h, trace, trail, copy),
          withHeadingCopy(h, bodyOf(h, trace, node, patches, diffStyle), node, copy.maybeCopied),
        ),
    );
};
