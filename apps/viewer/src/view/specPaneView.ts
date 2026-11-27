import {
  PrdSectionId,
  SectionId,
  type PassageStep,
  type Trace,
  type TraceSection,
  type TraceTask,
} from "@cairn/contract";
import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Array, Option, Predicate, Schema, String } from "effect";

import { diagramView } from "../diagram.ts";
import { disclosureView, segmentedView } from "../effect-ui/controls.ts";
import { styleText } from "../effect-ui/attributes.ts";
import { memoView } from "../effect-ui/memo.ts";
import { nodeSearchOf, type NodeSearch } from "../highlight.ts";
import { linkedMarksOf, sectionPathOf } from "../links.ts";
import { documentOf, renderSection, type SectionHooks } from "../markdown.ts";
import { PASSAGE_ATTRIBUTE } from "../subscription/selection.ts";
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
import { dotView, gateView, labelView, tagView } from "../ui/marks.ts";
import { hoverChainOf, isSpecDimmed, isTaskDimmed, rowKey, specKey, strayKey } from "../wires.ts";
import { copyButtonView, copyPassageView, passageButtonFor } from "./copyLinkView.ts";
import { modelChipView, modelSquareView } from "./modelView.ts";
import { fieldView, matchView, titleView, withSearched } from "./nodeView.ts";
import { withHover } from "./wiresView.ts";

const isPrdSection = Schema.is(PrdSectionId);

const DENSITIES: ReadonlyArray<{ readonly label: string; readonly value: Density }> = [
  { label: "Titles", value: "titles" },
  { label: "Summary", value: "summary" },
  { label: "Full spec", value: "full" },
];

const isDone = (task: TraceTask): boolean => task.status === "done" || task.status === "landed";

const judgmentView = (h: Html.H<Message>, mark: JudgmentMark) =>
  h.span
    .attr("data-judgment", mark.verdict)
    .attr("data-stale", `${mark.stale}`)
    .children(mark.stale ? `${mark.verdict} (stale)` : mark.verdict);

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
  h: Html.H<Message>,
  trace: Trace,
  specId: string,
  task: TraceTask,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
) => {
  const search = nodeSearchOf(results, maybeActive, { id: task.id, kind: "task" });
  return withSearched(
    withHover(
      h.button
        .attr("type", "button")
        .class("row")
        .attr("data-task-row", `${specId}:${task.id}`)
        .attr("data-wire", rowKey(specId, task.id))
        .attr("title", task.title)
        .on("click", Message.ClickedTask({ id: task.id })),
      { id: task.id, kind: "task" },
    ),
    search,
  )
    .attr("data-dimmed", isTaskDimmed(maybeChain, task.id) ? "" : undefined)
    .children(
      dotView(h, task.status),
      tagView(h, "task", fieldView(h, search, "id", task.id)),
      h.span.class("row-title").children(titleView(h, search, task.title)),
      task.gate.required && gateView(h),
      Option.getOrUndefined(
        Option.map(judgmentMarkOf(trace, { id: task.id, kind: "task" }), (mark) =>
          judgmentView(h, mark),
        ),
      ),
      isShowingModels && modelChipView(h, ranOf(task)),
      h.span.class("row-count").children(progressText(task)),
    );
};

const tasksView = (
  h: Html.H<Message>,
  trace: Trace,
  specId: string,
  tasks: ReadonlyArray<TraceTask>,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
) =>
  h.div
    .class("card-tasks")
    .children(
      Array.map(tasks, (task) =>
        taskRowView(h, trace, specId, task, isShowingModels, maybeChain, results, maybeActive),
      ),
    );

/** Renders inline backtick spans in a plain summary string as `code` elements. */
const summaryContentOf = (h: Html.H<Message>, summary: string) =>
  Array.map(String.split(summary, "`"), (part, index) =>
    index % 2 === 1 ? h.code.children(part) : part,
  );

/**
 * The line with the section's ID, then the section's own markdown, with the matched text of its
 * prose marked and the open link's passage underlined. Each block with a search mark carries
 * `data-block`, which a selected result scrolls to.
 */
const fullSectionView = (
  h: Html.H<Message>,
  trace: Trace,
  section: TraceSection,
  search: NodeSearch,
  results: ReadonlyArray<SearchResult>,
  maybePassage: Option.Option<typeof PassageStep.Type>,
) => {
  // A section's ID is the same text whichever document's brand it carries.
  const sectionId: string = section.id;
  const hooks: SectionHooks<Message> = {
    blockAttributesOf: (offset: number) => ({ "data-block": blockKeyFor("spec", offset) }),
    // An `Implements` chip that names a PRD section or item scrolls the PRD pane to it.
    chipMessageOf: (key, id) =>
      key === "Implements"
        ? Option.map(Option.liftPredicate(id, isPrdSection), (prd) =>
            Message.ClickedImplementsChip({ id: prd }),
          )
        : Option.none(),
    diagramView: (source, key) => diagramView(h, source, key),
    linked: linkedMarksOf(
      trace,
      Option.filter(maybePassage, (passage) => passage.section === sectionId),
      "spec",
    ),
    marks: marksOf("spec", results),
    markView: (text: string) => matchView(h, text),
  };
  return h.div.attr("data-full-spec", section.id).children(
    h.div.class("card-meta").children(fieldView(h, search, "id", section.id)),
    h.div
      .class("prose")
      .attr(PASSAGE_ATTRIBUTE, section.id)
      .children(renderSection(documentOf(trace.spec.markdown), section.id, h, hooks)),
  );
};

/**
 * One spec card. Its header is where the curve from the PRD heading ends, and hovering it lights
 * its chain; a card outside the hovered chain is dimmed. It is one memoised slot per card, keyed
 * by its section (the section is the first argument): a card is rebuilt only when the trace, the
 * density, the cards opened on their own, the hovered node, the copied link or the search changes,
 * so a measurement never renders markdown.
 */
const cardView = (
  h: Html.H<Message>,
  section: TraceSection,
  trace: Trace,
  reader: Reader,
  isShowingModels: boolean,
  maybeHovered: Option.Option<Node>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  maybeCopiedLink: Option.Option<string>,
  selectedSection: string,
  isSelectionOverLimit: boolean,
) => {
  const tasks = tasksOf(trace, section);
  const isCompleted = Array.isReadonlyArrayNonEmpty(tasks) && Array.every(tasks, isDone);
  const maybeChain = hoverChainOf(trace, maybeHovered);
  const search = nodeSearchOf(results, maybeActive, { id: section.id, kind: "section" });
  // A card holding the active result's matched prose is shown open for as long as it is active.
  const isOpen =
    isOpenCard(reader, section.id) ||
    (search.isActive && Option.exists(search.maybeMatch, (match) => match.field === "prose"));
  const showsSummary = !isOpen && reader.density !== "titles";
  const maybeSummary = Option.filter(Option.fromNullOr(section.summary), () => showsSummary);
  return disclosureView(h, {
    id: `spec-card-${section.id}`,
    isOpen,
    onToggle: () => Message.ClickedCardHeader({ id: section.id }),
    view: ({ button, panel }) =>
      withSearched(
        h.article
          .class("card")
          .attr("data-spec", section.id)
          .attr("data-completed", `${isCompleted}`),
        search,
      )
        .attr("data-dimmed", isSpecDimmed(maybeChain, section.id) ? "" : undefined)
        .children(
          withHover(button(h.button.class("card-head")).attr("data-wire", specKey(section.id)), {
            id: section.id,
            kind: "section",
          }).children(
            tagView(h, "spec", "SPEC"),
            h.span.class("card-title").children(titleView(h, search, section.title)),
            Option.getOrUndefined(
              Option.map(judgmentMarkOf(trace, { id: section.id, kind: "section" }), (mark) =>
                judgmentView(h, mark),
              ),
            ),
            isCompleted &&
              h.span
                .class("card-completed")
                .children(h.span.attr("aria-hidden", "true").children("✓"), "Completed"),
            isShowingModels &&
              Array.isReadonlyArrayNonEmpty(tasks) &&
              h.span
                .class("card-mix")
                .attr("data-model-squares", section.id)
                .children(Array.map(tasks, (task) => modelSquareView(h, ranOf(task)))),
            Array.isReadonlyArrayNonEmpty(tasks) &&
              h.span
                .class("card-count")
                .attr("data-done", "")
                .children(`${Array.length(Array.filter(tasks, isDone))}/${Array.length(tasks)}`),
            h.span.class("card-arrow").attr("aria-hidden", "true").children("›"),
          ),
          // Beside the header, not in it: a button holds no button.
          h.div
            .class("card-copy")
            .children(
              copyButtonView(h, maybeCopiedLink, sectionPathOf(section.id), "Copy link"),
              Option.getOrUndefined(
                Option.map(
                  passageButtonFor(selectedSection, isSelectionOverLimit, section.id),
                  (passage) => copyPassageView(h, passage),
                ),
              ),
            ),
          isOpen
            ? panel(h.div.class("card-body")).children(
                fullSectionView(h, trace, section, search, results, reader.maybePassage),
              )
            : Option.getOrUndefined(
                Option.map(maybeSummary, (summary) =>
                  h.p
                    .class("card-body")
                    .attr("data-summary", section.id)
                    .attr("style", styleText({ margin: "0" }))
                    .children(summaryContentOf(h, summary)),
                ),
              ),
          tasksView(h, trace, section.id, tasks, isShowingModels, maybeChain, results, maybeActive),
        ),
  });
};

/** The last card: the tasks that name the PRD section but none of the spec sections that implement it. */
const straysView = (
  h: Html.H<Message>,
  trace: Trace,
  strays: ReadonlyArray<TraceTask>,
  isShowingModels: boolean,
  maybeChain: Option.Option<Chain>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
) =>
  Array.isReadonlyArrayEmpty(strays)
    ? []
    : [
        h.article
          .class("card")
          .attr("data-strays", "")
          .attr(
            "data-dimmed",
            Array.every(strays, (task) => isTaskDimmed(maybeChain, task.id)) ? "" : undefined,
          )
          .children(
            h.div
              .class("card-head")
              .children(
                tagView(h, "prd", "PRD"),
                h.span.class("card-title").children("Tasks that name this section directly"),
              ),
            tasksView(
              h,
              trace,
              strayKey,
              strays,
              isShowingModels,
              maybeChain,
              results,
              maybeActive,
            ),
          ),
      ];

const sectionsText = (count: number, title: string): string =>
  `Spec · ${pluralOf(count, "section")} for ${title}`;

const paneView = (h: Html.H<Message>, key: string, children: View.Input<Message>) =>
  h.div
    .attr("role", "region")
    .attr("aria-label", "Spec")
    .attr("data-spec-pane", "")
    .attr(
      "style",
      styleText({
        "min-height": "0",
        "min-width": "0",
        "overflow-x": "hidden",
        "overflow-y": "auto",
      }),
    )
    .children(h.div.key(key).class("spec-col").children(children));

/**
 * The spec pane: a card for each spec section that implements the current PRD section, in the
 * spec's order, with a control for how much of every card shows. A section the spec does not build
 * shows its note in place of the cards. The content is keyed by the current section, so a new
 * section starts at the top of its cards.
 */
export const specPaneView = (
  h: Html.H<Message>,
  trace: Trace,
  maybeCurrent: Option.Option<PrdSectionId>,
  reader: Reader,
  isShowingModels: boolean,
  maybeHovered: Option.Option<Node>,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  maybeCopiedLink: Option.Option<string>,
  selectedSection: string,
  isSelectionOverLimit: boolean,
) =>
  Option.match(maybeCurrent, {
    onNone: () => paneView(h, "none", []),
    onSome: (current) =>
      paneView(
        h,
        current,
        Option.match(Option.flatMap(sectionStatusOf(trace, SectionId.make(current)), coverageOf), {
          onNone: () => {
            const { cards, strays } = cardsOf(trace, current);
            const maybeChain = hoverChainOf(trace, maybeHovered);
            return Array.appendAll(
              [
                h.div.class("col-head").children(
                  labelView(
                    h,
                    sectionsText(
                      Array.length(cards),
                      sectionTitleOf(trace, SectionId.make(current)),
                    ),
                  ),
                  segmentedView(h, {
                    label: "How much of the spec to show",
                    onSelect: (density) => Message.ClickedDensity({ density }),
                    options: DENSITIES,
                    selected: reader.density,
                  }),
                ),
              ],
              Array.appendAll(
                Array.map(cards, ({ section }) =>
                  memoView(
                    h,
                    cardView,
                    section,
                    trace,
                    reader,
                    isShowingModels,
                    maybeHovered,
                    results,
                    maybeActive,
                    maybeCopiedLink,
                    // A card is given the selection only when it holds it.
                    selectedSection === section.id ? selectedSection : "",
                    selectedSection === section.id && isSelectionOverLimit,
                  ),
                ),
                straysView(h, trace, strays, isShowingModels, maybeChain, results, maybeActive),
              ),
            );
          },
          onSome: (note) => [
            h.div
              .class("col-head")
              .children(
                labelView(h, sectionsText(0, sectionTitleOf(trace, SectionId.make(current)))),
              ),
            h.p.class("spec-note").attr("data-spec-note", "").children(note),
          ],
        }),
      ),
  });
