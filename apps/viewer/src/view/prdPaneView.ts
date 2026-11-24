import {
  PrdSectionId,
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
  Schema,
  Stream,
  String,
} from "effect";
import { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { diagramView } from "../diagram.ts";
import { Message } from "../message.ts";
import { renderMarkdown } from "../markdown.ts";
import {
  coverageOf,
  countsOf,
  planCountsOf,
  sectionAtTop,
  statusWordOf,
  type Counts,
  type SectionTop,
} from "../reader.ts";
import { sectionStatusOf } from "../trace.ts";
import { dotView } from "../ui/marks.ts";

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

const levelOf = (trace: Trace, id: SectionId): Option.Option<TraceSection> =>
  Array.findFirst(trace.prd.sections, (section) => section.id === id);

/** `in progress · 3 spec · 5/12 tasks`. */
export const statusLineText = (status: SectionStatus, counts: Counts): string =>
  `${statusWordOf(status)} · ${counts.specs} spec · ${counts.done}/${counts.tasks} tasks`;

/** A coverage note as text, or the status line as a button that pins the section. */
const statusLineView = (
  trace: Trace,
  id: PrdSectionId,
  status: SectionStatus,
  isPinned: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(coverageOf(status), {
    onNone: () =>
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
    onSome: (note) => h.span([h.DataAttribute("coverage", status)], [note]),
  });

/** The section's ID, small beside its title; it reads "copied" once the clipboard took it. */
const idButtonView = (id: PrdSectionId, isCopied: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("tag"),
      h.DataAttribute("kind", "prd"),
      h.DataAttribute("section-id", id),
      h.AriaLabel(`Copy the section ID ${id}`),
      h.OnClick(Message.ClickedSectionId({ id })),
    ],
    [isCopied ? "copied" : id],
  );

/** The title over the document, and how many of the plan's tasks are done, with a meter. */
const headerView = (trace: Trace, h: HtmlBuilder<Message>): Html => {
  const counts = planCountsOf(trace);
  const percent = counts.tasks === 0 ? 0 : (counts.done * 100) / counts.tasks;
  return h.div(
    [h.DataAttribute("prd-header", ""), h.Style({ margin: "0 0 20px" })],
    [
      h.p(
        [h.DataAttribute("prd-title", ""), h.Style({ "font-size": "var(--t-2xl)", margin: "0" })],
        [
          Option.match(
            Array.findFirst(trace.prd.sections, (section) => section.level === 1),
            { onNone: () => trace.feature, onSome: (title) => title.title },
          ),
        ],
      ),
      h.div(
        [h.Style({ "align-items": "center", display: "flex", gap: "12px", "margin-top": "6px" })],
        [
          h.span(
            [h.DataAttribute("plan-count", "")],
            [`${counts.done} of ${counts.tasks} tasks done`],
          ),
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
        ],
      ),
    ],
  );
};

/**
 * The PRD pane: the document as prose, with a status line and a copyable ID on each heading. The
 * current section's heading has `data-current`. The pane scrolls on its own and its mount follows
 * the section at its top.
 */
export const prdPaneView = (
  trace: Trace,
  maybeCurrent: Option.Option<PrdSectionId>,
  maybePinned: Option.Option<PrdSectionId>,
  maybeCopied: Option.Option<PrdSectionId>,
  h: HtmlBuilder<Message>,
): Html => {
  const attributesOf = (sectionId: SectionId) =>
    Array.appendAll(
      Option.exists(maybeCurrent, (current) => String.Equivalence(current, sectionId))
        ? [h.DataAttribute("current", "")]
        : [],
      Option.exists(levelOf(trace, sectionId), (section) => section.level === 1)
        ? [h.Attribute(TITLE_ATTRIBUTE, "")]
        : [],
    );
  const decorate = (sectionId: SectionId): ReadonlyArray<Html> =>
    Array.flatMap(
      Array.fromOption(Option.liftPredicate(sectionId, isPrdSection)),
      (id): ReadonlyArray<Html> =>
        Array.appendAll(
          [idButtonView(id, Option.contains(maybeCopied, id), h)],
          // The document's title is not a section a reader is on, so it has no status line.
          Option.exists(levelOf(trace, id), (section) => section.level === 1)
            ? []
            : Array.map(Array.fromOption(sectionStatusOf(trace, id)), (status) =>
                h.span(
                  [h.Style({ display: "block", "margin-top": "4px" })],
                  [statusLineView(trace, id, status, Option.contains(maybePinned, id), h)],
                ),
              ),
        ),
    );
  return h.div(
    [
      h.Role("region"),
      h.AriaLabel("PRD"),
      h.DataAttribute("prd-pane", ""),
      h.OnMount(TrackPrdScroll()),
      h.Style({ "min-height": "0", "overflow-y": "auto" }),
    ],
    [
      h.div(
        [h.Style({ margin: "0 auto", "max-width": "760px", padding: "24px 28px 96px" })],
        [
          headerView(trace, h),
          h.div(
            [h.Class("prose")],
            [
              renderMarkdown(trace.prd.markdown, h, {
                attributesOf,
                decorate,
                diagramView: (source, key) => diagramView(h, source, key),
                headingOffset: 1,
              }),
            ],
          ),
        ],
      ),
    ],
  );
};
