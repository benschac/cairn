import {
  SectionId,
  type PrdSectionId,
  type Trace,
  type TraceSection,
  type TraceTask,
} from "@cairn/contract";
import { Array, Option, Predicate } from "effect";
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html";

import { diagramView } from "../diagram.ts";
import { documentOf, renderSection } from "../markdown.ts";
import { Message } from "../message.ts";
import type { Density, Reader } from "../model.ts";
import { cardsOf, coverageOf, isOpenCard, ranOf, statusWordOf, tasksOf } from "../reader.ts";
import {
  judgmentMarkOf,
  sectionStatusOf,
  sectionTitleOf,
  type Chain,
  type JudgmentMark,
  type Node,
} from "../trace.ts";
import { disclosureView, segmentedView } from "../ui/controls.ts";
import { dotView, gateView, labelView, tagView } from "../ui/marks.ts";
import { hoverChainOf, isSpecDimmed, isTaskDimmed, rowKey, specKey, strayKey } from "../wires.ts";
import { modelChipView, modelSquareView } from "./modelView.ts";
import { hoverAttributesOf } from "./wiresView.ts";

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

/**
 * A task row: a button that opens the task's detail. `specId` is `_` in the card of strays. The row
 * is where a curve to its task's chip starts, and counts as its task when hovered or dimmed.
 */
const taskRowView = (
  trace: Trace,
  specId: string,
  task: TraceTask,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    Array.flatten([
      [
        h.Type("button"),
        h.Class("row"),
        h.DataAttribute("task-row", `${specId}:${task.id}`),
        h.DataAttribute("wire", rowKey(specId, task.id)),
        h.OnClick(Message.ClickedTask({ id: task.id })),
      ],
      hoverAttributesOf({ id: task.id, kind: "task" }, h),
      isTaskDimmed(maybeChain, task.id) ? [h.DataAttribute("dimmed", "")] : [],
    ]),
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
        Array.prepend(
          isShowingModels ? [modelChipView(ranOf(task), h)] : [],
          h.span([h.Class("label")], [progressText(task)]),
        ),
      ),
    ),
  );

const tasksView = (
  trace: Trace,
  specId: string,
  tasks: ReadonlyArray<TraceTask>,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("card-tasks")],
    Array.map(tasks, (task) => taskRowView(trace, specId, task, isShowingModels, maybeChain, h)),
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

/**
 * One spec card. Its header is where the curve from the PRD heading ends, and hovering it lights
 * its chain; a card outside the hovered chain is dimmed.
 */
const cardView = (
  trace: Trace,
  section: TraceSection,
  reader: Reader,
  isShowingModels: boolean,
  maybeHovered: Option.Option<Node>,
  h: HtmlBuilder<Message>,
): Html => {
  const tasks = tasksOf(trace, section);
  const maybeChain = hoverChainOf(trace, maybeHovered);
  const isOpen = isOpenCard(reader, section.id);
  const showsSummary = !isOpen && reader.density !== "titles";
  return disclosureView(
    {
      id: `spec-card-${section.id}`,
      isOpen,
      onToggle: () => Message.ClickedCardHeader({ id: section.id }),
      toView: ({ button, panel }) =>
        h.article(
          Array.appendAll(
            [h.Class("card"), h.DataAttribute("spec", section.id)],
            isSpecDimmed(maybeChain, section.id) ? [h.DataAttribute("dimmed", "")] : [],
          ),
          Array.appendAll(
            [
              h.button(
                Array.appendAll(
                  Array.prepend(button, h.Class("card-head")),
                  Array.prepend(
                    hoverAttributesOf({ id: section.id, kind: "section" }, h),
                    h.DataAttribute("wire", specKey(section.id)),
                  ),
                ),
                Array.appendAll(
                  Array.appendAll(
                    [
                      h.span([], [section.title]),
                      h.span(
                        [h.DataAttribute("done", "")],
                        [`${Array.length(Array.filter(tasks, isDone))}/${Array.length(tasks)}`],
                      ),
                    ],
                    isShowingModels
                      ? [
                          h.span(
                            [h.DataAttribute("model-squares", section.id)],
                            Array.map(tasks, (task) => modelSquareView(ranOf(task), h)),
                          ),
                        ]
                      : [],
                  ),
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
              [tasksView(trace, section.id, tasks, isShowingModels, maybeChain, h)],
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
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.isReadonlyArrayEmpty(strays)
    ? []
    : [
        h.article(
          Array.appendAll(
            [h.Class("card"), h.DataAttribute("strays", "")],
            Array.every(strays, (task) => isTaskDimmed(maybeChain, task.id))
              ? [h.DataAttribute("dimmed", "")]
              : [],
          ),
          [
            h.div([h.Class("card-head")], ["Tasks that name this section directly"]),
            tasksView(trace, strayKey, strays, isShowingModels, maybeChain, h),
          ],
        ),
      ];

/**
 * One slot per card, keyed by its section: a card is rebuilt only when the trace, the density, the
 * cards opened on their own or the hovered node changes, so a measurement never renders markdown.
 */
const cardLazy = createKeyedLazy();

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
  isShowingModels: boolean,
  maybeHovered: Option.Option<Node>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(maybeCurrent, {
    onNone: () => paneView([], "none", h),
    onSome: (current) =>
      paneView(
        Option.match(Option.flatMap(sectionStatusOf(trace, SectionId.make(current)), coverageOf), {
          onNone: () => {
            const { cards, strays } = cardsOf(trace, current);
            const maybeChain = hoverChainOf(trace, maybeHovered);
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
                Array.map(cards, ({ section }) =>
                  cardLazy(section.id, cardView, [
                    trace,
                    section,
                    reader,
                    isShowingModels,
                    maybeHovered,
                    h,
                  ]),
                ),
                straysView(trace, strays, isShowingModels, maybeChain, h),
              ),
            );
          },
          onSome: (note) => [h.p([h.DataAttribute("spec-note", "")], [note])],
        }),
        current,
        h,
      ),
  });
