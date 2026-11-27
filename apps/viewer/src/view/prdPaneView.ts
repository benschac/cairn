import {
  PrdSectionId,
  type PassageStep,
  type SectionId,
  type SectionStatus,
  type Trace,
  type TraceSection,
} from "@cairn/contract";
import { Mount as UiMount } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import {
  Array,
  Cause,
  Effect,
  Match,
  MutableRef,
  Option,
  Predicate,
  Queue,
  Record,
  Schema,
  Stream,
  String,
} from "effect";

import { diagramView } from "../diagram.ts";
import { styleText } from "../effect-ui/attributes.ts";
import { memoView } from "../effect-ui/memo.ts";
import { linkedMarksOf, sectionPathOf, type PassageButton } from "../links.ts";
import { Message } from "../message.ts";
import {
  documentOf,
  renderSection,
  renderSectionTitle,
  type MarkdownDocument,
  type Marks,
  type Rendered,
  type SectionHooks,
} from "../markdown.ts";
import { nodeSearchOf, type NodeSearch } from "../highlight.ts";
import type { Range } from "../range.ts";
import {
  coverageOf,
  countsOf,
  isOpenPrdSection,
  planCountsOf,
  sectionAtTop,
  statusWordOf,
  type Counts,
  type Folded,
  type SectionTop,
} from "../reader.ts";
import type { SectionReader } from "../readers.ts";
import { blockKeyFor, marksOf, type SearchResult } from "../search.ts";
import { PASSAGE_ATTRIBUTE } from "../subscription/selection.ts";
import { sectionStatusOf, type Node } from "../trace.ts";
import { disclosureView } from "../effect-ui/controls.ts";
import { dotView } from "../ui/marks.ts";
import { prdKey } from "../wires.ts";
import { withHover } from "./wiresView.ts";
import { copyButtonView, copyPassageView, passageButtonFor } from "./copyLinkView.ts";
import { fieldView, matchView, withSearched } from "./nodeView.ts";

/** How far below the pane's top the line is that decides which section is being read. */
export const TOP_LINE = 140;

/** The document's own title carries this, so the pane's tracking leaves it out. */
const TITLE_ATTRIBUTE = "data-title";

const HEADINGS = `[data-section]:not([${TITLE_ATTRIBUTE}])`;

const decodePrdSectionId = Schema.decodeUnknownOption(PrdSectionId);
const isPrdSection = Schema.is(PrdSectionId);

/** The top edge of each PRD section's heading in the pane, in document order. */
const topsOf = (pane: Element): ReadonlyArray<SectionTop> =>
  Array.getSomes(
    Array.map(Array.fromIterable(pane.querySelectorAll(HEADINGS)), (heading) =>
      Option.map(
        Option.flatMap(Option.fromNullOr(heading.getAttribute("data-section")), decodePrdSectionId),
        (id) => ({ id, top: heading.getBoundingClientRect().top }),
      ),
    ),
  );

/** The section at the top of the pane: the last heading at or above the line, or the first. */
const topSectionOf = (pane: Element): Option.Option<PrdSectionId> =>
  sectionAtTop(topsOf(pane), pane.getBoundingClientRect().top + TOP_LINE);

type PrdMessage = typeof Message.cases.ScrolledPrd.Type;

/**
 * Reports the section at the top of the pane once it mounts and then whenever it changes. A
 * scroll or a resize of the content asks for a look, and the look happens at most once per
 * animation frame; the answer is sent only when it differs from the last one sent. The listener,
 * the observer and a pending frame are released when the pane goes.
 */
const trackScroll = (element: Element, queue: Queue.Queue<PrdMessage, Cause.Done>) =>
  Effect.gen(function* () {
    const sent = MutableRef.make(Option.none<PrdSectionId>());
    const frame = MutableRef.make(Option.none<number>());
    const report = () =>
      Option.match(
        Option.filter(topSectionOf(element), (id) => !Option.contains(MutableRef.get(sent), id)),
        {
          onNone: () => undefined,
          onSome: (id) => {
            MutableRef.set(sent, Option.some(id));
            Queue.offerUnsafe(queue, Message.ScrolledPrd({ id }));
          },
        },
      );
    const schedule = () =>
      Option.match(MutableRef.get(frame), {
        onNone: () =>
          MutableRef.set(
            frame,
            Option.some(
              requestAnimationFrame(() => {
                MutableRef.set(frame, Option.none());
                report();
              }),
            ),
          ),
        onSome: () => undefined,
      });
    yield* Effect.acquireRelease(
      Effect.sync(() => element.addEventListener("scroll", schedule)),
      () => Effect.sync(() => element.removeEventListener("scroll", schedule)),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => Option.map(MutableRef.get(frame), cancelAnimationFrame)),
    );
    // Environments without ResizeObserver (jsdom) look at the scroll alone.
    if (Predicate.hasProperty(globalThis, "ResizeObserver")) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const observer = new ResizeObserver(schedule);
          Option.map(Option.fromNullOr(element.firstElementChild), (content) =>
            observer.observe(content),
          );
          return observer;
        }),
        (observer) => Effect.sync(() => observer.disconnect()),
      );
    }
    yield* Effect.sync(report);
  });

/**
 * Follows the section at the top of the PRD pane: it sends `ScrolledPrd` once when it mounts and
 * then each time the answer changes. Nothing in the model changes on a scroll but that.
 */
export const TrackPrdScroll = UiMount.makeStream(
  "TrackPrdScroll",
  { args: {} },
  (element: HTMLElement) => Stream.callback<PrdMessage>((queue) => trackScroll(element, queue)),
);

/** `3 spec · 5/12 tasks`. */
const itemCountsText = (counts: Counts): string =>
  `${counts.specs} spec · ${counts.done}/${counts.tasks} tasks`;

/** `in progress · 3 spec · 5/12 tasks`. */
export const statusLineText = (status: SectionStatus, counts: Counts): string =>
  `${statusWordOf(status)} · ${itemCountsText(counts)}`;

/**
 * What the markdown of the document is rendered with: the parsed document, and the stretches a
 * search matched and a link's passage covers.
 */
interface Markup {
  readonly document: MarkdownDocument;
  readonly linked: Record.ReadonlyRecord<string, ReadonlyArray<Range>>;
  readonly marks: Marks;
  /** What a list item's annotation and attributes read: the trace, the pin and the copied ID. */
  readonly trace: Trace;
  readonly maybeCurrent: Option.Option<PrdSectionId>;
  readonly maybePinned: Option.Option<PrdSectionId>;
  readonly maybeCopied: Option.Option<PrdSectionId>;
  /** The IDs of the sections and items marked: the one a spec card's chip named, and the ones a hovered task builds. */
  readonly marked: ReadonlyArray<string>;
}

/** The item's ID, small after its text; it shows on hover and on focus within the item and copies on click. */
const itemIdView = (h: Html.H<Message>, id: PrdSectionId, isCopied: boolean) =>
  h.button
    .attr("type", "button")
    .class("prd-id item-id")
    .attr("data-item-id", id)
    .attr("aria-label", `Copy the item ID ${id}`)
    .attr("title", "Copy the item ID")
    .on("click", Message.ClickedSectionId({ id }))
    .children(isCopied ? "copied" : id);

/**
 * The end of a list item: its annotation, a button that pins the item and shows its status and
 * `1 spec · 2/7 tasks`, or `nothing maps to this`; then its ID. Hovering the annotation lights the
 * item's chain.
 */
const itemAnnotationView = (h: Html.H<Message>, markup: Markup, id: SectionId): Rendered<Message> =>
  Array.flatMap(Array.fromOption(Option.liftPredicate(id, isPrdSection)), (prd) => {
    const counts = countsOf(markup.trace, prd);
    return [
      withHover(
        h.button
          .attr("type", "button")
          .class("btn item-note")
          .attr("data-item-annotation", prd)
          .attr("aria-pressed", `${Option.contains(markup.maybePinned, prd)}`)
          .on("click", Message.ClickedItemAnnotation({ id: prd })),
        { id: prd, kind: "section" },
      ).children(
        Option.getOrUndefined(
          Option.map(sectionStatusOf(markup.trace, prd), (status) => dotView(h, status)),
        ),
        counts.specs === 0 && counts.tasks === 0 ? "nothing maps to this" : itemCountsText(counts),
      ),
      itemIdView(h, prd, Option.contains(markup.maybeCopied, prd)),
    ];
  });

const hooksOf = (h: Html.H<Message>, markup: Markup): SectionHooks<Message> => ({
  blockAttributesOf: (offset: number) => ({ "data-block": blockKeyFor("prd", offset) }),
  diagramView: (source, key) => diagramView(h, source, key),
  itemAnnotation: (id) => itemAnnotationView(h, markup, id),
  itemAttributesOf: (id) => ({
    "data-current": Option.exists(markup.maybeCurrent, (current) => String.Equivalence(current, id))
      ? ""
      : undefined,
    "data-marked": Array.contains(markup.marked, id) ? "" : undefined,
  }),
  linked: markup.linked,
  marks: markup.marks,
  markView: (text: string) => matchView(h, text),
});

/** A section's own markdown. */
const proseView = (h: Html.H<Message>, markup: Markup, id: SectionId) =>
  renderSection(markup.document, id, h, hooksOf(h, markup));

/** A section's title as markdown renders it, or the title's plain text when the document has none. */
const titleContentOf = (h: Html.H<Message>, markup: Markup, section: TraceSection) => {
  const rendered = renderSectionTitle(markup.document, section.id, h, hooksOf(h, markup));
  return Array.isReadonlyArrayEmpty(rendered) ? [section.title] : rendered;
};

/**
 * A coverage note as text, or the status line as a button that pins the section. The pinned
 * section's row also copies the link up to its step.
 */
const statusLineView = (
  h: Html.H<Message>,
  trace: Trace,
  id: PrdSectionId,
  status: SectionStatus,
  isPinned: boolean,
  pinnedPath: string,
  maybeCopiedLink: Option.Option<string>,
  maybePassageButton: Option.Option<PassageButton>,
) =>
  Option.match(coverageOf(status), {
    onNone: () =>
      h.div.class("prd-pinrow").children(
        h.button
          .attr("type", "button")
          .class("btn")
          .attr("data-status-line", id)
          .attr("aria-pressed", `${isPinned}`)
          .on("click", Message.ClickedStatusLine({ id }))
          .children(dotView(h, status), statusLineText(status, countsOf(trace, id))),
        // The pinned section's link, up to its step: the passage when one replaced the section.
        isPinned && copyButtonView(h, maybeCopiedLink, pinnedPath, "Copy link"),
        Option.getOrUndefined(
          Option.map(maybePassageButton, (button) => copyPassageView(h, button)),
        ),
      ),
    onSome: (note) => {
      const covered = h.p.class("prd-covnote").attr("data-coverage", status).children(note);
      // A selection in a section with a coverage note puts its button in a row under the note.
      return Option.match(maybePassageButton, {
        onNone: () => covered,
        onSome: (button) => h.div.class("prd-pinrow").children(covered, copyPassageView(h, button)),
      });
    },
  });

/** The section's ID, small beside its title; it reads "copied" once the clipboard took it. */
const idButtonView = (
  h: Html.H<Message>,
  id: PrdSectionId,
  isCopied: boolean,
  search: NodeSearch,
) =>
  h.button
    .attr("type", "button")
    .class("prd-id")
    .attr("data-section-id", id)
    .attr("aria-label", `Copy the section ID ${id}`)
    .attr("title", "Copy the section ID")
    .on("click", Message.ClickedSectionId({ id }))
    .children(isCopied ? "copied" : fieldView(h, search, "id", id));

/**
 * A chip for each other participant reading the section, beside its heading: their label, as the
 * top bar's "Here now" has it. Two readers on one section show two chips; nobody shows none.
 */
const readersView = (
  h: Html.H<Message>,
  id: PrdSectionId,
  everyone: ReadonlyArray<SectionReader>,
) => {
  const readers = Array.filter(everyone, (reader) => reader.section === id);
  return Array.match(readers, {
    onEmpty: () => [],
    onNonEmpty: (present) => [
      h.span
        .attr("data-readers", id)
        .attr("style", styleText({ display: "inline-flex", gap: "4px", "margin-left": "8px" }))
        .children(
          Array.map(present, (reader) =>
            h.span
              .class("chip")
              .attr("data-reading", reader.id)
              .attr("title", `${reader.label} is reading this section`)
              .children(reader.label),
          ),
        ),
    ],
  });
};

/** What follows a heading: the section's ID, its Copy link button and the other readers. */
const identityViews = (
  h: Html.H<Message>,
  id: PrdSectionId & SectionId,
  isCopied: boolean,
  maybeCopiedLink: Option.Option<string>,
  search: NodeSearch,
  readers: ReadonlyArray<SectionReader>,
) =>
  Array.appendAll(
    [
      idButtonView(h, id, isCopied, search),
      copyButtonView(h, maybeCopiedLink, sectionPathOf(id), "Copy link"),
    ],
    readersView(h, id, readers),
  );

/** Any heading builder: a union of the five tags would lose the requirements of what is built on it. */
type HeadingBuilder = Html.Element<Message, never, Html.EventsOf<"h2">, HTMLHeadingElement>;

const headingTagOf = (level: number, h: Html.H<Message>): HeadingBuilder =>
  Match.value(level).pipe(
    Match.when(2, () => h.h2),
    Match.when(3, () => h.h3),
    Match.when(4, () => h.h4),
    Match.when(5, () => h.h5),
    Match.orElse(() => h.h6),
  );

/** Folds every section to its heading, or unfolds them all. */
const condenseButtonView = (h: Html.H<Message>, isPrdCondensed: boolean) =>
  h.button
    .attr("type", "button")
    .class("btn prd-condense")
    .attr("data-prd-condense", "")
    .on("click", Message.ClickedCondensePrd())
    .children(isPrdCondensed ? "Expand all" : "Collapse all");

/** The progress meter and done count at the bottom of the document head, and the fold control. */
const progressView = (h: Html.H<Message>, trace: Trace, folded: Folded) => {
  const counts = planCountsOf(trace);
  const percent = counts.tasks === 0 ? 0 : (counts.done * 100) / counts.tasks;
  return h.div.class("prd-prog").children(
    h.div
      .class("meter")
      .attr("role", "meter")
      .attr("aria-label", "Tasks done")
      .attr("aria-valuemin", "0")
      .attr("aria-valuemax", `${counts.tasks}`)
      .attr("aria-valuenow", `${counts.done}`)
      .children(h.div.attr("style", styleText({ width: `${percent}%` }))),
    h.span.attr("data-plan-count", "").children(`${counts.done} of ${counts.tasks} tasks done`),
    condenseButtonView(h, folded.isPrdCondensed),
  );
};

/** The document head: source path, title, intro prose and plan progress with a meter. */
const headerView = (
  h: Html.H<Message>,
  trace: Trace,
  markup: Markup,
  maybeTitle: Option.Option<TraceSection>,
  maybeCopied: Option.Option<PrdSectionId>,
  maybeCopiedLink: Option.Option<string>,
  folded: Folded,
  searchOf: (sectionId: SectionId) => NodeSearch,
  readers: ReadonlyArray<SectionReader>,
) =>
  h.div
    .class("prd-head")
    .attr("data-prd-header", "")
    .children(
      Option.match(maybeTitle, {
        onNone: () => [
          h.div.class("prd-crumb").children(".cairn/prd.md"),
          h.div
            .class("prd-doc-title")
            .children(
              h.h2.class("prd-doc-heading").attr("data-prd-title", "").children(trace.feature),
            ),
          progressView(h, trace, folded),
        ],
        onSome: (section) => [
          h.div.class("prd-crumb").children(".cairn/prd.md"),
          withSearched(
            h.header
              .class("prd-doc-title")
              .id(section.id)
              .attr("data-section", section.id)
              .attr(TITLE_ATTRIBUTE, ""),
            searchOf(section.id),
          ).children(
            h.h2
              .class("prd-doc-heading")
              .attr("data-prd-title", "")
              .children(titleContentOf(h, markup, section)),
            Array.flatMap(Array.fromOption(Option.liftPredicate(section.id, isPrdSection)), (id) =>
              identityViews(
                h,
                id,
                Option.contains(maybeCopied, id),
                maybeCopiedLink,
                searchOf(id),
                readers,
              ),
            ),
          ),
          h.div.class("prose").children(proseView(h, markup, section.id)),
          progressView(h, trace, folded),
        ],
      }),
    );

/**
 * One PRD section below the title: a monospace header, status line or coverage note, and prose.
 * The arrow before the title is a disclosure button: a closed section shows its header alone.
 */
const sectionView = (
  h: Html.H<Message>,
  trace: Trace,
  markup: Markup,
  section: TraceSection,
  maybeCurrent: Option.Option<PrdSectionId>,
  maybePinned: Option.Option<PrdSectionId>,
  pinnedPath: string,
  maybeCopied: Option.Option<PrdSectionId>,
  maybeCopiedLink: Option.Option<string>,
  maybePassageButton: Option.Option<PassageButton>,
  folded: Folded,
  searchOf: (sectionId: SectionId) => NodeSearch,
  readers: ReadonlyArray<SectionReader>,
) => {
  const maybeId = Option.liftPredicate(section.id, isPrdSection);
  const headingTag = headingTagOf(section.level, h);
  const isCurrent = Option.exists(maybeCurrent, (current) =>
    String.Equivalence(current, section.id),
  );
  const search = searchOf(section.id);
  // A section holding the active result's matched prose is shown open for as long as it is active.
  const isOpen =
    isOpenPrdSection(folded, section.id) ||
    (search.isActive && Option.exists(search.maybeMatch, (match) => match.field === "prose"));
  return disclosureView(h, {
    id: `prd-section-${section.id}`,
    isOpen,
    onToggle: () => Message.ClickedPrdHeading({ id: section.id }),
    view: ({ button, panel }) =>
      h.section
        .class("prd-sec")
        .attr("data-depth", `${section.level}`)
        .attr("data-open", `${isOpen}`)
        .attr("data-prd-sec", section.id)
        .children(
          withSearched(
            h.header
              .class("prd-sec-head")
              .id(section.id)
              .attr("data-section", section.id)
              .attr("data-current", isCurrent ? "" : undefined)
              .attr("data-marked", Array.contains(markup.marked, section.id) ? "" : undefined)
              .attr("data-wire", isCurrent ? prdKey(PrdSectionId.make(section.id)) : undefined),
            search,
          ).children(
            h.div.class("prd-sh").children(
              headingTag
                .class("prd-title")
                .attr("data-depth", `${section.level}`)
                .children(
                  // Only the arrow is the button: a title can hold a link, and a link
                  // inside the button would fold the section as it navigates.
                  button(
                    h.button
                      .class("prd-fold")
                      .attr("data-prd-fold", section.id)
                      .attr("aria-label", section.title),
                  ).children(
                    h.span.class("prd-fold-arrow").attr("aria-hidden", "true").children("›"),
                  ),
                  titleContentOf(h, markup, section),
                ),
              Array.flatMap(Array.fromOption(maybeId), (id) =>
                identityViews(
                  h,
                  id,
                  Option.contains(maybeCopied, id),
                  maybeCopiedLink,
                  search,
                  readers,
                ),
              ),
            ),
            Array.flatMap(Array.fromOption(maybeId), (id) =>
              Array.map(Array.fromOption(sectionStatusOf(trace, id)), (status) =>
                statusLineView(
                  h,
                  trace,
                  id,
                  status,
                  Option.contains(maybePinned, id),
                  pinnedPath,
                  maybeCopiedLink,
                  maybePassageButton,
                ),
              ),
            ),
          ),
          isOpen &&
            panel(
              h.div
                .class("prose")
                .attr("data-prd-prose", section.id)
                .attr(PASSAGE_ATTRIBUTE, section.id),
            ).children(proseView(h, markup, section.id)),
        ),
  });
};

/**
 * What the PRD pane holds: the document head, then each section as a monospace header with its
 * copyable ID and status line over its prose. The current section's header has `data-current` and
 * `data-wire`, which the curve to its spec cards starts from. What the search matched is marked in
 * the headings and the prose, and a heading it matched is outlined, as is the active result. A
 * link's passage is underlined in the prose.
 */
const prdBodyView = (
  h: Html.H<Message>,
  trace: Trace,
  maybeCurrent: Option.Option<PrdSectionId>,
  maybePinned: Option.Option<PrdSectionId>,
  isPrdCondensed: boolean,
  prdOpened: Record.ReadonlyRecord<string, boolean>,
  maybeCopied: Option.Option<PrdSectionId>,
  maybeCopiedLink: Option.Option<string>,
  pinnedPath: string,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  maybePassage: Option.Option<typeof PassageStep.Type>,
  selectedSection: string,
  isSelectionOverLimit: boolean,
  readers: ReadonlyArray<SectionReader>,
  marked: string,
) => {
  const markup: Markup = {
    document: documentOf(trace.prd.markdown),
    linked: linkedMarksOf(trace, maybePassage, "prd"),
    marked: String.split(marked, " "),
    marks: marksOf("prd", results),
    maybeCopied,
    maybeCurrent,
    maybePinned,
    trace,
  };
  const folded: Folded = { isPrdCondensed, prdOpened };
  const searchOf = (sectionId: SectionId) =>
    nodeSearchOf(results, maybeActive, { id: sectionId, kind: "section" });
  const maybeTitle = Array.findFirst(trace.prd.sections, (section) => section.level === 1);
  const bodySections = Array.filter(trace.prd.sections, (section) => section.level > 1);
  return h.div.class("prd-body").children(
    headerView(
      h,
      trace,
      markup,
      maybeTitle,
      maybeCopied,
      maybeCopiedLink,
      folded,
      searchOf,
      readers,
    ),
    Array.map(bodySections, (section) =>
      sectionView(
        h,
        trace,
        markup,
        section,
        maybeCurrent,
        maybePinned,
        pinnedPath,
        maybeCopied,
        maybeCopiedLink,
        passageButtonFor(selectedSection, isSelectionOverLimit, section.id),
        folded,
        searchOf,
        readers,
      ),
    ),
  );
};

/**
 * The PRD pane: the document as prose, with a status line and a copyable ID on each heading. The
 * pane scrolls on its own and its mount follows the section at its top. The body is one memoised
 * slot (`memoView`): it is rebuilt only when the trace, the current section, the pin, the folded sections, the
 * copied ID or link, the pinned link, the search, the passage or the room changes, so a
 * measurement or a hover never renders the document again, and a query only matches and marks:
 * the parsed document is shared.
 */
export const prdPaneView = (
  h: Html.H<Message>,
  trace: Trace,
  maybeCurrent: Option.Option<PrdSectionId>,
  maybePinned: Option.Option<PrdSectionId>,
  isPrdCondensed: boolean,
  prdOpened: Record.ReadonlyRecord<string, boolean>,
  maybeCopied: Option.Option<PrdSectionId>,
  maybeCopiedLink: Option.Option<string>,
  pinnedPath: string,
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  maybePassage: Option.Option<typeof PassageStep.Type>,
  selectedSection: string,
  isSelectionOverLimit: boolean,
  readers: ReadonlyArray<SectionReader>,
  marked: string,
) =>
  h.div
    .attr("role", "region")
    .attr("aria-label", "PRD")
    .attr("data-prd-pane", "")
    .onMount(TrackPrdScroll())
    .attr(
      "style",
      styleText({
        "min-height": "0",
        "min-width": "0",
        "overflow-x": "hidden",
        "overflow-y": "auto",
      }),
    )
    .children(
      memoView(
        h,
        prdBodyView,
        trace,
        maybeCurrent,
        maybePinned,
        isPrdCondensed,
        prdOpened,
        maybeCopied,
        maybeCopiedLink,
        pinnedPath,
        results,
        maybeActive,
        maybePassage,
        selectedSection,
        isSelectionOverLimit,
        readers,
        marked,
      ),
    );
