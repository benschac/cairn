import {
  SectionId,
  type PrdSectionId,
  type Trace,
  type TraceSection,
  type TraceTask,
} from "@cairn/contract";
import { Array, Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { diagramView } from "../diagram.ts";
import { documentOf, renderSection } from "../markdown.ts";
import { Message } from "../message.ts";
import type { Density, Reader } from "../model.ts";
import { cardsOf, coverageOf, isOpenCard, statusWordOf, type Card } from "../reader.ts";
import { judgmentMarkOf, sectionStatusOf, sectionTitleOf, type JudgmentMark } from "../trace.ts";
import { disclosureView, segmentedView } from "../ui/controls.ts";
import { dotView, gateView, labelView, tagView } from "../ui/marks.ts";

const DENSITIES: ReadonlyArray<{ readonly label: string; readonly value: Density }> = [
  { label: "Titles", value: "titles" },
  { label: "Summary", value: "summary" },
  { label: "Full spec", value: "full" },
];

const isDone = (task: TraceTask): boolean => task.status === "done" || task.status === "landed";

const judgmentView = (mark: JudgmentMark, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.DataAttribute("judgment", mark.verdict), h.DataAttribute("stale", `${mark.stale}`)],
    [mark.stale ? `${mark.verdict} (stale)` : mark.verdict],
  );

const pluralOf = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** The commit count, with "· session" when a commit has one; the status word before there is a commit. */
const progressText = (task: TraceTask): string =>
  Array.isReadonlyArrayEmpty(task.commits)
    ? statusWordOf(task.status)
    : `${pluralOf(Array.length(task.commits), "commit")}${
        Array.some(task.commits, (commit) => Predicate.isNotNull(commit.session))
          ? " · session"
          : ""
      }`;

/** A task row: a button that opens the task's detail. `specId` is `_` in the card of strays. */
const taskRowView = (
  trace: Trace,
  specId: string,
  task: TraceTask,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("row"),
      h.DataAttribute("task-row", `${specId}:${task.id}`),
      h.OnClick(Message.ClickedTask({ id: task.id })),
    ],
    Array.appendAll(
      [
        dotView(task.status, h),
        tagView("task", task.id, h),
        h.span([h.Style({ flex: "1", "min-width": "0" })], [task.title]),
      ],
      Array.appendAll(
        Array.appendAll(
          task.gate.required ? [gateView(h)] : [],
          Array.fromOption(
            Option.map(judgmentMarkOf(trace, { id: task.id, kind: "task" }), (mark) =>
              judgmentView(mark, h),
            ),
          ),
        ),
        [h.span([h.Class("label")], [progressText(task)])],
      ),
    ),
  );

const tasksView = (
  trace: Trace,
  specId: string,
  tasks: ReadonlyArray<TraceTask>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("card-tasks")],
    Array.map(tasks, (task) => taskRowView(trace, specId, task, h)),
  );

/** The line with the section's ID, then the section's own markdown. */
const fullSectionView = (trace: Trace, section: TraceSection, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("prose"), h.DataAttribute("full-spec", section.id)],
    [
      tagView("spec", section.id, h),
      renderSection(documentOf(trace.spec.markdown), section.id, h, {
        diagramView: (source, key) => diagramView(h, source, key),
      }),
    ],
  );

const cardView = (trace: Trace, card: Card, reader: Reader, h: HtmlBuilder<Message>): Html => {
  const { section, tasks } = card;
  const isOpen = isOpenCard(reader, section.id);
  const showsSummary = !isOpen && reader.density !== "titles";
  return disclosureView(
    {
      id: `spec-card-${section.id}`,
      isOpen,
      onToggle: () => Message.ClickedCardHeader({ id: section.id }),
      toView: ({ button, panel }) =>
        h.article(
          [h.Class("card"), h.DataAttribute("spec", section.id)],
          Array.appendAll(
            [
              h.button(
                Array.prepend(button, h.Class("card-head")),
                Array.appendAll(
                  [
                    h.span([], [section.title]),
                    h.span(
                      [h.DataAttribute("done", "")],
                      [`${Array.length(Array.filter(tasks, isDone))}/${Array.length(tasks)}`],
                    ),
                  ],
                  Array.fromOption(
                    Option.map(judgmentMarkOf(trace, { id: section.id, kind: "section" }), (mark) =>
                      judgmentView(mark, h),
                    ),
                  ),
                ),
              ),
            ],
            Array.appendAll(
              isOpen
                ? [
                    h.div(Array.prepend(panel, h.Class("card-body")), [
                      fullSectionView(trace, section, h),
                    ]),
                  ]
                : Array.map(
                    Array.filter(
                      Array.fromOption(Option.fromNullOr(section.summary)),
                      () => showsSummary,
                    ),
                    (summary) =>
                      h.p(
                        [
                          h.Class("card-body"),
                          h.DataAttribute("summary", section.id),
                          h.Style({ margin: "0" }),
                        ],
                        [summary],
                      ),
                  ),
              [tasksView(trace, section.id, tasks, h)],
            ),
          ),
        ),
    },
    h,
  );
};

/** The last card: the tasks that name the PRD section but none of the spec sections that implement it. */
const straysView = (
  trace: Trace,
  strays: ReadonlyArray<TraceTask>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.isReadonlyArrayEmpty(strays)
    ? []
    : [
        h.article(
          [h.Class("card"), h.DataAttribute("strays", "")],
          [
            h.div([h.Class("card-head")], ["Tasks that name this section directly"]),
            tasksView(trace, "_", strays, h),
          ],
        ),
      ];

const sectionsText = (count: number, title: string): string =>
  `Spec · ${pluralOf(count, "section")} for ${title}`;

const paneView = (children: ReadonlyArray<Html>, key: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role("region"),
      h.AriaLabel("Spec"),
      h.DataAttribute("spec-pane", ""),
      h.Style({ "min-height": "0", "overflow-y": "auto" }),
    ],
    [
      h.keyed("div")(
        key,
        [h.Style({ display: "grid", gap: "12px", padding: "24px 20px 96px" })],
        children,
      ),
    ],
  );

/**
 * The spec pane: a card for each spec section that implements the current PRD section, in the
 * spec's order, with a control for how much of every card shows. A section the spec does not build
 * shows its note in place of the cards. The content is keyed by the current section, so a new
 * section starts at the top of its cards.
 */
export const specPaneView = (
  trace: Trace,
  maybeCurrent: Option.Option<PrdSectionId>,
  reader: Reader,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeCurrent, {
    onNone: () => paneView([], "none", h),
    onSome: (current) =>
      paneView(
        Option.match(Option.flatMap(sectionStatusOf(trace, SectionId.make(current)), coverageOf), {
          onNone: () => {
            const { cards, strays } = cardsOf(trace, current);
            return Array.appendAll(
              [
                h.div(
                  [
                    h.Style({
                      "align-items": "center",
                      display: "flex",
                      "justify-content": "space-between",
                      gap: "12px",
                    }),
                  ],
                  [
                    labelView(
                      sectionsText(
                        Array.length(cards),
                        sectionTitleOf(trace, SectionId.make(current)),
                      ),
                      h,
                    ),
                    segmentedView(
                      {
                        label: "How much of the spec to show",
                        onSelect: (density) => Message.ClickedDensity({ density }),
                        options: DENSITIES,
                        selected: reader.density,
                      },
                      h,
                    ),
                  ],
                ),
              ],
              Array.appendAll(
                Array.map(cards, (card) => cardView(trace, card, reader, h)),
                straysView(trace, strays, h),
              ),
            );
          },
          onSome: (note) => [h.p([h.DataAttribute("spec-note", "")], [note])],
        }),
        current,
        h,
      ),
  });
