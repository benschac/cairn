import {
  PrdSectionId,
  type PassageStep,
  type SectionId,
  type SectionStatus,
  type Trace,
  type TraceSection,
} from "@cairn/contract";
import {
  Array,
  Cause,
  Effect,
  MutableRef,
  Option,
  Predicate,
  Queue,
  Record,
  Schema,
  Stream,
  String,
} from "effect";
import { Mount } from "foldkit";
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html";

import { diagramView } from "../diagram.ts";
import type { SectionReader } from "../readers.ts";
import { Message } from "../message.ts";
import {
  documentOf,
  renderSection,
  renderSectionTitle,
  type MarkdownDocument,
  type Rendered,
  type SectionHooks,
} from "../markdown.ts";
import { linkedMarksOf, sectionPathOf } from "../links.ts";
import { blockKeyFor, marksOf, type SearchResult } from "../search.ts";
import { copyButtonView } from "./copyLinkView.ts";
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
import { nodeSearchOf, type NodeSearch } from "../highlight.ts";
import { sectionStatusOf, type Node } from "../trace.ts";
import { disclosureView } from "../ui/controls.ts";
import { dotView } from "../ui/marks.ts";
import { prdKey } from "../wires.ts";
import { fieldView, matchView, searchedAttributesOf } from "./nodeView.ts";

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

type PrdMessage = typeof Message.ScrolledPrd.Type;

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
export const TrackPrdScroll = Mount.defineStream("TrackPrdScroll", {
  execute: ({ element }) => Stream.callback<PrdMessage>((queue) => trackScroll(element, queue)),
  messages: [Message.ScrolledPrd],
});

/** `in progress · 3 spec · 5/12 tasks`. */
export const statusLineText = (status: SectionStatus, counts: Counts): string =>
  `${statusWordOf(status)} · ${counts.specs} spec · ${counts.done}/${counts.tasks} tasks`;

/**
 * A coverage note as text, or the status line as a button that pins the section. The pinned
 * section's row also copies the link up to its step.
 */
const statusLineView = (
  trace: Trace,
  id: PrdSectionId,
  status: SectionStatus,
  isPinned: boolean,
  pinnedPath: string,
  maybeCopiedLink: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(coverageOf(status), {
    onNone: () =>
      h.div(
        [h.Class("prd-pinrow")],
        Array.appendAll(
          [
            h.button(
              [
                h.Type("button"),
                h.Class("btn"),
                h.DataAttribute("status-line", id),
                h.AriaPressed(`${isPinned}`),
                h.OnClick(Message.ClickedStatusLine({ id })),
              ],
              [dotView(status, h), statusLineText(status, countsOf(trace, id))],
            ),
          ],
          // The pinned section's link, up to its step: the passage when one replaced the section.
          isPinned ? [copyButtonView(maybeCopiedLink, pinnedPath, "Copy link", h)] : [],
        ),
      ),
    onSome: (note) => h.p([h.Class("prd-covnote"), h.DataAttribute("coverage", status)], [note]),
  });

/** The section's ID, small beside its title; it reads "copied" once the clipboard took it. */
const idButtonView = (
  id: PrdSectionId,
  isCopied: boolean,
  search: NodeSearch,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("prd-id"),
      h.DataAttribute("section-id", id),
      h.AriaLabel(`Copy the section ID ${id}`),
      h.Title("Copy the section ID"),
      h.OnClick(Message.ClickedSectionId({ id })),
    ],
    isCopied ? ["copied"] : fieldView(search, "id", id, h),
  );

/**
 * A chip for each other participant reading the section, beside its heading: their label, as the
 * top bar's "Here now" has it. Two readers on one section show two chips; nobody shows none.
 */
const readersView = (
  id: PrdSectionId,
  everyone: ReadonlyArray<SectionReader>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const readers = Array.filter(everyone, (reader) => reader.section === id);
  return Array.match(readers, {
    onEmpty: () => [],
    onNonEmpty: (present) => [
      h.span(
        [
          h.DataAttribute("readers", id),
          h.Style({ display: "inline-flex", gap: "4px", "margin-left": "8px" }),
        ],
        Array.map(present, (reader) =>
          h.span(
            [
              h.Class("chip"),
              h.DataAttribute("reading", reader.id),
              h.Title(`${reader.label} is reading this section`),
            ],
            [reader.label],
          ),
        ),
      ),
    ],
  });
};

const titleContentOf = (
  document: MarkdownDocument,
  section: TraceSection,
  hooks: SectionHooks<Message>,
  h: HtmlBuilder<Message>,
): Rendered => {
  const rendered = renderSectionTitle(document, section.id, h, hooks);
  return Array.isReadonlyArrayEmpty(rendered) ? [section.title] : rendered;
};

const headingTagOf = (level: number, h: HtmlBuilder<Message>) =>
  Option.getOrElse(Array.get([h.h2, h.h3, h.h4, h.h5, h.h6], level - 2), () => h.h6);

/** Folds every section to its heading, or unfolds them all. */
const condenseButtonView = (isPrdCondensed: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("btn prd-condense"),
      h.DataAttribute("prd-condense", ""),
      h.OnClick(Message.ClickedCondensePrd()),
    ],
    [isPrdCondensed ? "Expand all" : "Collapse all"],
  );

/** The progress meter and done count at the bottom of the document head, and the fold control. */
const progressView = (trace: Trace, folded: Folded, h: HtmlBuilder<Message>): Html => {
  const counts = planCountsOf(trace);
  const percent = counts.tasks === 0 ? 0 : (counts.done * 100) / counts.tasks;
  return h.div(
    [h.Class("prd-prog")],
    [
      h.div(
        [
          h.Class("meter"),
          h.Role("meter"),
          h.AriaLabel("Tasks done"),
          h.AriaValuemin(0),
          h.AriaValuemax(counts.tasks),
          h.AriaValuenow(counts.done),
        ],
        [h.div([h.Style({ width: `${percent}%` })])],
      ),
      h.span([h.DataAttribute("plan-count", "")], [`${counts.done} of ${counts.tasks} tasks done`]),
      condenseButtonView(folded.isPrdCondensed, h),
    ],
  );
};

/** The document head: source path, title, intro prose and plan progress with a meter. */
const headerView = (
  trace: Trace,
  document: MarkdownDocument,
  maybeTitle: Option.Option<TraceSection>,
  maybeCopied: Option.Option<PrdSectionId>,
  maybeCopiedLink: Option.Option<string>,
  folded: Folded,
  searchOf: (sectionId: SectionId) => NodeSearch,
  readers: ReadonlyArray<SectionReader>,
  hooks: SectionHooks<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("prd-head"), h.DataAttribute("prd-header", "")],
    Option.match(maybeTitle, {
      onNone: () => [
        h.div([h.Class("prd-crumb")], [".cairn/prd.md"]),
        h.div(
          [h.Class("prd-doc-title")],
          [h.h2([h.Class("prd-doc-heading"), h.DataAttribute("prd-title", "")], [trace.feature])],
        ),
        progressView(trace, folded, h),
      ],
      onSome: (section) => [
        h.div([h.Class("prd-crumb")], [".cairn/prd.md"]),
        h.header(
          Array.appendAll(
            [
              h.Class("prd-doc-title"),
              h.Id(section.id),
              h.DataAttribute("section", section.id),
              h.Attribute(TITLE_ATTRIBUTE, ""),
            ],
            searchedAttributesOf(searchOf(section.id), h),
          ),
          Array.prepend(
            Array.flatMap(Array.fromOption(Option.liftPredicate(section.id, isPrdSection)), (id) =>
              Array.prependAll(readersView(id, readers, h), [
                idButtonView(id, Option.contains(maybeCopied, id), searchOf(id), h),
                copyButtonView(maybeCopiedLink, sectionPathOf(id), "Copy link", h),
              ]),
            ),
            h.h2(
              [h.Class("prd-doc-heading"), h.DataAttribute("prd-title", "")],
              titleContentOf(document, section, hooks, h),
            ),
          ),
        ),
        h.div([h.Class("prose")], [renderSection(document, section.id, h, hooks)]),
        progressView(trace, folded, h),
      ],
    }),
  );

/**
 * One PRD section below the title: a monospace header, status line or coverage note, and prose.
 * The arrow before the title is a disclosure button: a closed section shows its header alone.
 */
const sectionView = (
  trace: Trace,
  document: MarkdownDocument,
  section: TraceSection,
  maybeCurrent: Option.Option<PrdSectionId>,
  maybePinned: Option.Option<PrdSectionId>,
  pinnedPath: string,
  maybeCopied: Option.Option<PrdSectionId>,
  maybeCopiedLink: Option.Option<string>,
  folded: Folded,
  searchOf: (sectionId: SectionId) => NodeSearch,
  readers: ReadonlyArray<SectionReader>,
  hooks: SectionHooks<Message>,
  h: HtmlBuilder<Message>,
): Html => {
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
  return disclosureView(
    {
      id: `prd-section-${section.id}`,
      isOpen,
      onToggle: () => Message.ClickedPrdHeading({ id: section.id }),
      toView: ({ button, panel }) =>
        h.section(
          [
            h.Class("prd-sec"),
            h.DataAttribute("depth", `${section.level}`),
            h.DataAttribute("open", `${isOpen}`),
            h.DataAttribute("prd-sec", section.id),
          ],
          Array.appendAll(
            [
              h.header(
                Array.flatten([
                  [
                    h.Class("prd-sec-head"),
                    h.Id(section.id),
                    h.DataAttribute("section", section.id),
                  ],
                  searchedAttributesOf(search, h),
                  isCurrent
                    ? [
                        h.DataAttribute("current", ""),
                        h.DataAttribute("wire", prdKey(PrdSectionId.make(section.id))),
                      ]
                    : [],
                ]),
                Array.prepend(
                  Array.flatMap(Array.fromOption(maybeId), (id) =>
                    Array.map(Array.fromOption(sectionStatusOf(trace, id)), (status) =>
                      statusLineView(
                        trace,
                        id,
                        status,
                        Option.contains(maybePinned, id),
                        pinnedPath,
                        maybeCopiedLink,
                        h,
                      ),
                    ),
                  ),
                  h.div(
                    [h.Class("prd-sh")],
                    Array.prepend(
                      Array.flatMap(Array.fromOption(maybeId), (id) =>
                        Array.prependAll(readersView(id, readers, h), [
                          idButtonView(id, Option.contains(maybeCopied, id), search, h),
                          copyButtonView(maybeCopiedLink, sectionPathOf(id), "Copy link", h),
                        ]),
                      ),
                      headingTag(
                        [h.Class("prd-title"), h.DataAttribute("depth", `${section.level}`)],
                        // Only the arrow is the button: a title can hold a link, and a link
                        // inside the button would fold the section as it navigates.
                        Array.prepend(
                          titleContentOf(document, section, hooks, h),
                          h.button(
                            Array.appendAll(button, [
                              h.Class("prd-fold"),
                              h.DataAttribute("prd-fold", section.id),
                              h.AriaLabel(section.title),
                            ]),
                            [h.span([h.Class("prd-fold-arrow"), h.AriaHidden(true)], ["›"])],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
            isOpen
              ? [
                  h.div(
                    Array.appendAll(panel, [
                      h.Class("prose"),
                      h.DataAttribute("prd-prose", section.id),
                    ]),
                    [renderSection(document, section.id, h, hooks)],
                  ),
                ]
              : [],
          ),
        ),
    },
    h,
  );
};

/**
 * What the PRD pane holds: the document head, then each section as a monospace header with its
 * copyable ID and status line over its prose. The current section's header has `data-current` and
 * `data-wire`, which the curve to its spec cards starts from. What the search matched is marked in
 * the headings and the prose, and a heading it matched is outlined, as is the active result. A
 * link's passage is underlined in the prose.
 */
const prdBodyView = (
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
  readers: ReadonlyArray<SectionReader>,
  h: HtmlBuilder<Message>,
): Html => {
  const document = documentOf(trace.prd.markdown);
  const folded: Folded = { isPrdCondensed, prdOpened };
  const searchOf = (sectionId: SectionId) =>
    nodeSearchOf(results, maybeActive, { id: sectionId, kind: "section" });
  const hooks: SectionHooks<Message> = {
    blockAttributesOf: (offset: number) => [h.DataAttribute("block", blockKeyFor("prd", offset))],
    diagramView: (source, key) => diagramView(h, source, key),
    linked: linkedMarksOf(trace, maybePassage, "prd"),
    marks: marksOf("prd", results),
    markView: (text: string) => matchView(text, h),
  };
  const maybeTitle = Array.findFirst(trace.prd.sections, (section) => section.level === 1);
  const bodySections = Array.filter(trace.prd.sections, (section) => section.level > 1);
  return h.div(
    [h.Class("prd-body")],
    Array.prepend(
      Array.map(bodySections, (section) =>
        sectionView(
          trace,
          document,
          section,
          maybeCurrent,
          maybePinned,
          pinnedPath,
          maybeCopied,
          maybeCopiedLink,
          folded,
          searchOf,
          readers,
          hooks,
          h,
        ),
      ),
      headerView(
        trace,
        document,
        maybeTitle,
        maybeCopied,
        maybeCopiedLink,
        folded,
        searchOf,
        readers,
        hooks,
        h,
      ),
    ),
  );
};

/**
 * One slot: the body is rebuilt only when the trace, the current section, the pin, the folded
 * sections, the copied ID or link, the pinned link, the search, the passage or the room changes, so a measurement or a hover never renders the document again, and a query
 * only matches and marks: the parsed document is shared.
 */
const prdBodyLazy = createLazy();

/**
 * The PRD pane: the document as prose, with a status line and a copyable ID on each heading. The
 * pane scrolls on its own and its mount follows the section at its top.
 */
export const prdPaneView = (
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
  readers: ReadonlyArray<SectionReader>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Role("region"),
      h.AriaLabel("PRD"),
      h.DataAttribute("prd-pane", ""),
      h.OnMount(TrackPrdScroll()),
      h.Style({
        "min-height": "0",
        "min-width": "0",
        "overflow-x": "hidden",
        "overflow-y": "auto",
      }),
    ],
    [
      prdBodyLazy(prdBodyView, [
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
        readers,
        h,
      ]),
    ],
  );
