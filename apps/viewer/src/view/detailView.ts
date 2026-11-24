import { SectionId, type Trace, type TraceSection, type TraceTask } from "@cairn/contract";
import { Array, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { DETAIL_HEADING_ID, type Trail } from "../detail.ts";
import { eventsView, gateView, judgmentsView } from "../drawer.ts";
import { shortSha } from "../codeView.ts";
import { Message } from "../message.ts";
import { ranOf, statusWordOf } from "../reader.ts";
import { stacksOf } from "../stacks.ts";
import { Node, nodeKeyOf, sectionTitleOf } from "../trace.ts";
import { dotView, labelView, tagView } from "../ui/marks.ts";
import { DIVIDER_WIDTH, dividerView } from "./dividerView.ts";
import type { Widths } from "../panes.ts";

// NOTE: the buttons here are native buttons with Type("button"), as the drawer's are.

const taskNode = (id: TraceTask["id"]): Node => ({ id, kind: "task" });
const sectionIdOf = (id: string): SectionId => SectionId.make(id);
const sectionNode = (id: string): Node => ({ id: sectionIdOf(id), kind: "section" });

/** A button that adds a node to the trail. */
const addButton = (label: string, node: Node, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("btn"),
      h.DataAttribute("detail-add", nodeKeyOf(node)),
      h.OnClick(Message.ClickedDetailNode({ node })),
    ],
    [label],
  );

const partView = (
  part: string,
  heading: string,
  body: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.DataAttribute("detail-part", part), h.Style({ "margin-top": "16px" })],
    Array.prepend(body, labelView(heading, h)),
  );

/** What a trail step reads: a task by its ID, a spec section by its title. */
const stepLabelOf = (trace: Trace, node: Node): string =>
  Node.match(node, {
    section: ({ id }) => sectionTitleOf(trace, id),
    task: ({ id }) => id,
  });

/** The trail across the panel's top, with the button that closes the panel. */
const trailView = (trace: Trace, trail: Trail, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Style({
        "align-items": "center",
        display: "flex",
        gap: "6px",
        "justify-content": "space-between",
      }),
    ],
    [
      h.nav(
        [
          h.AriaLabel("Trail"),
          h.DataAttribute("detail-trail", ""),
          h.Style({ display: "flex", "flex-wrap": "wrap", gap: "6px", "min-width": "0" }),
        ],
        Array.map(trail, (node, index) =>
          h.button(
            Array.appendAll(
              [
                h.Type("button"),
                h.Class("btn"),
                h.DataAttribute("trail-step", `${index}`),
                h.OnClick(Message.ClickedTrailStep({ index })),
              ],
              index === Array.length(trail) - 1 ? [h.AriaCurrent("step")] : [],
            ),
            [stepLabelOf(trace, node)],
          ),
        ),
      ),
      h.button(
        [
          h.Type("button"),
          h.Class("btn"),
          h.DataAttribute("detail-close", ""),
          h.OnClick(Message.ClickedCloseDetail()),
        ],
        ["Close"],
      ),
    ],
  );

const headingView = (title: string, h: HtmlBuilder<Message>): Html =>
  // Tabindex(-1): the heading takes focus when the panel opens or its node changes, but is not a tab stop.
  h.h2([h.Id(DETAIL_HEADING_ID), h.Tabindex(-1)], [title]);

const commitsView = (task: TraceTask, h: HtmlBuilder<Message>): Html =>
  partView(
    "commits",
    "Commits",
    [
      h.ul(
        [],
        Array.map(task.commits, (commit) =>
          h.li(
            [],
            [
              h.button(
                [
                  h.Type("button"),
                  h.Class("btn"),
                  h.DataAttribute("detail-commit", commit.sha),
                  h.OnClick(
                    Message.ClickedOpenCode({ id: task.id, maybeSha: Option.some(commit.sha) }),
                  ),
                ],
                [`${commit.subject} ${shortSha(commit.sha)}`],
              ),
            ],
          ),
        ),
      ),
      h.button(
        [
          h.Type("button"),
          h.Class("btn"),
          h.DataAttribute("detail-open-code", ""),
          h.OnClick(Message.ClickedOpenCode({ id: task.id, maybeSha: Option.none() })),
        ],
        ["Open in code view"],
      ),
    ],
    h,
  );

const tracesView = (trace: Trace, task: TraceTask, h: HtmlBuilder<Message>): Html =>
  partView(
    "traces",
    "Traces to",
    [
      h.ul(
        [],
        Array.appendAll(
          Array.map(task.prdSections, (id) =>
            h.li(
              [],
              [
                h.button(
                  [
                    h.Type("button"),
                    h.Class("btn"),
                    h.DataAttribute("detail-prd", id),
                    h.OnClick(Message.ClickedTraceSection({ id })),
                  ],
                  [sectionTitleOf(trace, sectionIdOf(id))],
                ),
              ],
            ),
          ),
          Array.map(task.specSections, (id) =>
            h.li([], [addButton(sectionTitleOf(trace, sectionIdOf(id)), sectionNode(id), h)]),
          ),
        ),
      ),
    ],
    h,
  );

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

const taskView = (trace: Trace, task: TraceTask, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const ran = ranOf(task);
  return Array.flatten([
    [
      headingView(`${task.id} ${task.title}`, h),
      h.p(
        [h.DataAttribute("detail-part", "where")],
        Array.appendAll(
          [tagView("task", task.id, h), ` ${task.branch}`],
          Array.map(Array.fromOption(stackNumberOf(trace, task)), (number) => ` · Stack ${number}`),
        ),
      ),
      h.div(
        [h.DataAttribute("detail-part", "facts")],
        Array.appendAll(
          [
            h.p([], [dotView(task.status, h), ` ${statusWordOf(task.status)}`]),
            h.p(
              [h.DataAttribute("detail-ran", "")],
              [`${ran.ran ? "ran on" : "planned for"} ${ran.model} · ${ran.reasoning}`],
            ),
            h.p([h.DataAttribute("detail-parent", "")], [parentText(task)]),
          ],
          Array.match(
            Array.filter(task.dependsOn, (id) => id !== task.parent),
            {
              onEmpty: () => [],
              onNonEmpty: (others) => [
                h.p(
                  [h.DataAttribute("detail-depends", "")],
                  Array.prepend(
                    Array.map(others, (id) => addButton(id, taskNode(id), h)),
                    "Depends on ",
                  ),
                ),
              ],
            },
          ),
        ),
      ),
    ],
    task.gate.required ? [gateView(task, h)] : [],
    [
      commitsView(task, h),
      tracesView(trace, task, h),
      partView(
        "files",
        "Files the plan expects",
        [
          h.ul(
            [],
            Array.map(task.files, (file) => h.li([], [h.code([], [file])])),
          ),
        ],
        h,
      ),
      eventsView(task, h),
      judgmentsView(trace, taskNode(task.id), h),
    ],
  ]);
};

const keysView = (section: TraceSection, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.DataAttribute("detail-part", "keys"),
      h.Style({ display: "flex", "flex-wrap": "wrap", gap: "6px" }),
    ],
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
          h.span([h.Class("chip"), h.DataAttribute("detail-key", key)], [`${key}: ${value}`]),
        ),
    ),
  );

const sectionView = (trace: Trace, id: string, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const maybeSection = Array.findFirst(trace.spec.sections, (section) => section.id === id);
  const tasks = Array.filter(trace.tasks, (task) =>
    Array.some(task.specSections, (each) => each === id),
  );
  return Array.flatten([
    [headingView(sectionTitleOf(trace, sectionIdOf(id)), h), h.p([], [tagView("spec", id, h)])],
    Array.flatMap(Array.fromOption(maybeSection), (section) =>
      Array.appendAll(
        Array.map(Array.fromNullishOr(section.summary), (summary) =>
          h.p([h.DataAttribute("detail-part", "summary")], [summary]),
        ),
        [keysView(section, h)],
      ),
    ),
    [
      partView(
        "tasks",
        "Tasks",
        [
          h.ul(
            [],
            Array.map(tasks, (task) =>
              h.keyed("li")(
                task.id,
                [],
                [addButton(`${task.id} ${task.title}`, taskNode(task.id), h)],
              ),
            ),
          ),
        ],
        h,
      ),
      judgmentsView(trace, sectionNode(id), h),
    ],
  ]);
};

/** What the last node of the trail shows. A task the trace does not have shows its ID and nothing else. */
const bodyOf = (trace: Trace, node: Node, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Node.match(node, {
    section: ({ id }) => sectionView(trace, id, h),
    task: ({ id }) =>
      Option.match(
        Array.findFirst(trace.tasks, (task) => task.id === id),
        { onNone: () => [headingView(id, h)], onSome: (task) => taskView(trace, task, h) },
      ),
  });

/**
 * The detail panel: fixed to the right edge of the reader, full height, with its own scroll and a
 * divider on its left edge. It lies over the panes and moves none of them. The trail runs across
 * its top; the last node is shown under it. The part that scrolls is keyed by the node, so no DOM
 * state carries from one step to another.
 */
export const detailView = (
  trace: Trace,
  trail: Trail & Array.NonEmptyReadonlyArray<Node>,
  widths: Widths,
  h: HtmlBuilder<Message>,
): Html => {
  const node = Array.lastNonEmpty(trail);
  return h.aside(
    [
      h.AriaLabelledBy(DETAIL_HEADING_ID),
      h.Class("panel"),
      h.DataAttribute("detail", node.kind),
      h.DataAttribute("detail-id", node.id),
      h.Style({
        bottom: "0",
        "box-sizing": "border-box",
        "max-width": "100vw",
        position: "fixed",
        right: "0",
        top: "0",
        width: `${widths.detail}px`,
        "z-index": "10",
      }),
    ],
    [
      // The divider's strip is centred on the panel's left edge.
      h.div(
        [
          h.Style({
            bottom: "0",
            display: "grid",
            left: `-${DIVIDER_WIDTH / 2}px`,
            position: "absolute",
            top: "0",
          }),
        ],
        [dividerView("detail", widths, h)],
      ),
      h.keyed("div")(
        nodeKeyOf(node),
        [
          h.Style({
            "box-sizing": "border-box",
            height: "100%",
            "overflow-y": "auto",
            padding: "12px 16px",
          }),
        ],
        Array.prepend(bodyOf(trace, node, h), trailView(trace, trail, h)),
      ),
    ],
  );
};
