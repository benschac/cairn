import {
  SectionId,
  type PrdSectionId,
  type Trace,
  type TraceSection,
  type TraceTask,
} from "@cairn/contract";
import { Array, Option, Predicate, String } from "effect";
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html";

import { diagramView } from "../diagram.ts";
import { nodeSearchOf, type NodeSearch } from "../highlight.ts";
import { documentOf, renderSection, type Rendered } from "../markdown.ts";
import { Message } from "../message.ts";
import type { Density, Reader } from "../model.ts";
import { cardsOf, coverageOf, isOpenCard, ranOf, statusWordOf, tasksOf } from "../reader.ts";
import { blockKeyFor, marksOf, type SearchResult } from "../search.ts";
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
import { fieldView, matchView, searchedAttributesOf, titleView } from "./nodeView.ts";
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
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  h: HtmlBuilder<Message>,
): Html => {
  const search = nodeSearchOf(results, maybeActive, { id: task.id, kind: "task" });
  return h.button(
    Array.flatten([
      [
        h.Type("button"),
        h.Class("row"),
        h.DataAttribute("task-row", `${specId}:${task.id}`),
        h.DataAttribute("wire", rowKey(specId, task.id)),
        h.Title(task.title),
        h.OnClick(Message.ClickedTask({ id: task.id })),
      ],
      hoverAttributesOf({ id: task.id, kind: "task" }, h),
      searchedAttributesOf(search, h),
      isTaskDimmed(maybeChain, task.id) ? [h.DataAttribute("dimmed", "")] : [],
    ]),
    Array.appendAll(
      [
        dotView(task.status, h),
        tagView("task", fieldView(search, "id", task.id, h), h),
        h.span([h.Class("row-title")], titleView(search, [task.title], h)),
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
        Array.append(
          isShowingModels ? [modelChipView(ranOf(task), h)] : [],
          h.span([h.Class("row-count")], [progressText(task)]),
        ),
      ),
    ),
  );
};

const tasksView = (
  trace: Trace,
  specId: string,
  tasks: ReadonlyArray<TraceTask>,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("card-tasks")],
    Array.map(tasks, (task) =>
      taskRowView(trace, specId, task, isShowingModels, maybeChain, results, maybeActive, h),
    ),
  );

/** Renders inline backtick spans in a plain summary string as `code` elements. */
const summaryContentOf = (summary: string, h: HtmlBuilder<Message>): Rendered =>
  Array.map(String.split(summary, "`"), (part, index) =>
    index % 2 === 1 ? h.code([], [part]) : part,
  );

/**
 * The line with the section's ID, then the section's own markdown, with the matched text of its
 * prose marked. Each marked block carries `data-block`, which a selected result scrolls to.
 */
const fullSectionView = (
  trace: Trace,
  section: TraceSection,
  search: NodeSearch,
  results: ReadonlyArray<SearchResult>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.DataAttribute("full-spec", section.id)],
    [
      h.div([h.Class("card-meta")], fieldView(search, "id", section.id, h)),
      h.div(
        [h.Class("prose")],
        [
          renderSection(documentOf(trace.spec.markdown), section.id, h, {
            blockAttributesOf: (offset: number) => [
              h.DataAttribute("block", blockKeyFor("spec", offset)),
            ],
            diagramView: (source, key) => diagramView(h, source, key),
            marks: marksOf("spec", results),
            markView: (text: string) => matchView(text, h),
          }),
        ],
      ),
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
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  h: HtmlBuilder<Message>,
): Html => {
  const tasks = tasksOf(trace, section);
  const maybeChain = hoverChainOf(trace, maybeHovered);
  const search = nodeSearchOf(results, maybeActive, { id: section.id, kind: "section" });
  // A card holding the active result's matched prose is shown open for as long as it is active.
  const isOpen =
    isOpenCard(reader, section.id) ||
    (search.isActive && Option.exists(search.maybeMatch, (match) => match.field === "prose"));
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
            Array.appendAll(
              searchedAttributesOf(search, h),
              isSpecDimmed(maybeChain, section.id) ? [h.DataAttribute("dimmed", "")] : [],
            ),
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
                Array.flatten([
                  [
                    tagView("spec", "SPEC", h),
                    h.span([h.Class("card-title")], titleView(search, [section.title], h)),
                  ],
                  Array.fromOption(
                    Option.map(judgmentMarkOf(trace, { id: section.id, kind: "section" }), (mark) =>
                      judgmentView(mark, h),
                    ),
                  ),
                  isShowingModels && Array.isReadonlyArrayNonEmpty(tasks)
                    ? [
                        h.span(
                          [h.Class("card-mix"), h.DataAttribute("model-squares", section.id)],
                          Array.map(tasks, (task) => modelSquareView(ranOf(task), h)),
                        ),
                      ]
                    : [],
                  Array.isReadonlyArrayNonEmpty(tasks)
                    ? [
                        h.span(
                          [h.Class("card-count"), h.DataAttribute("done", "")],
                          [`${Array.length(Array.filter(tasks, isDone))}/${Array.length(tasks)}`],
                        ),
                      ]
                    : [],
                  [h.span([h.Class("card-arrow"), h.AriaHidden(true)], ["›"])],
                ]),
              ),
            ],
            Array.appendAll(
              isOpen
                ? [
                    h.div(Array.prepend(panel, h.Class("card-body")), [
                      fullSectionView(trace, section, search, results, h),
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
                        summaryContentOf(summary, h),
                      ),
                  ),
              [
                tasksView(
                  trace,
                  section.id,
                  tasks,
                  isShowingModels,
                  maybeChain,
                  results,
                  maybeActive,
                  h,
                ),
              ],
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
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
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
            h.div(
              [h.Class("card-head")],
              [
                tagView("prd", "PRD", h),
                h.span([h.Class("card-title")], ["Tasks that name this section directly"]),
              ],
            ),
            tasksView(
              trace,
              strayKey,
              strays,
              isShowingModels,
              maybeChain,
              results,
              maybeActive,
              h,
            ),
          ],
        ),
      ];

/**
 * One slot per card, keyed by its section: a card is rebuilt only when the trace, the density, the
 * cards opened on their own, the hovered node or the search changes, so a measurement never
 * renders markdown.
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
      h.Style({
        "min-height": "0",
        "min-width": "0",
        "overflow-x": "hidden",
        "overflow-y": "auto",
      }),
    ],
    [h.keyed("div")(key, [h.Class("spec-col")], children)],
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
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
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
                  [h.Class("col-head")],
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
                    results,
                    maybeActive,
                    h,
                  ]),
                ),
                straysView(trace, strays, isShowingModels, maybeChain, results, maybeActive, h),
              ),
            );
          },
          onSome: (note) => [
            h.div(
              [h.Class("col-head")],
              [labelView(sectionsText(0, sectionTitleOf(trace, SectionId.make(current))), h)],
            ),
            h.p([h.Class("spec-note"), h.DataAttribute("spec-note", "")], [note]),
          ],
        }),
        current,
        h,
      ),
  });
