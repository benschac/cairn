import { SectionId, type PrdSectionId, type TaskId, type Trace } from "@cairn/contract";
import type { NextTask, SectionLink, SectionLinks } from "@cairn/core/section-links";
import type { Html } from "@effect/ui/html";
import { Array, Option, String } from "effect";

import { switchView } from "../effect-ui/controls.ts";
import { Message } from "../message.ts";
import { linksFor, statusWordOf } from "../reader.ts";
import { sectionStatusOf, sectionTitleOf } from "../trace.ts";
import { dotView, labelView } from "../ui/marks.ts";
import { withHover } from "./wiresView.ts";

/** The switch's ID: only one list is open at a time. */
export const LINKS_SWITCH_ID = "links-transitive";

/** What a link reads as: an item's own text, else the section's title. */
const titleOf = (trace: Trace, id: PrdSectionId): string =>
  Option.match(
    Array.findFirst(trace.prd.items, (item) => String.Equivalence(item.id, id)),
    { onNone: () => sectionTitleOf(trace, SectionId.make(id)), onSome: (item) => item.text },
  );

/** `t95 needs t94, t96 needs t94`: the tasks that make the link. */
const pairsText = (link: SectionLink): string =>
  Array.join(
    Array.map(link.pairs, (pair) => `${pair.task} needs ${pair.needs}`),
    ", ",
  );

/**
 * A section or item at the other end of a link: a button with its status dot and title that
 * scrolls the PRD pane to it, the pairs of tasks that make the link, and with the transitive switch
 * on, the direct link it is reached through. Hovering it lights its tasks in the stacks.
 */
const linkedSectionView = (h: Html.H<Message>, trace: Trace, link: SectionLink) =>
  h.li
    .key(link.id)
    .attr("data-link", link.id)
    .children(
      withHover(
        h.button
          .attr("type", "button")
          .class("btn link-entry")
          .attr("data-link-section", link.id)
          .on("click", Message.ClickedLinkedSection({ id: link.id })),
        { id: SectionId.make(link.id), kind: "section" },
      ).children(
        Option.getOrUndefined(
          Option.map(sectionStatusOf(trace, SectionId.make(link.id)), (status) =>
            dotView(h, status),
          ),
        ),
        titleOf(trace, link.id),
      ),
      h.span.class("link-note").attr("data-link-pairs", "").children(pairsText(link)),
      Option.getOrUndefined(
        Option.map(link.via, (via) =>
          h.span
            .class("link-note")
            .attr("data-link-via", via)
            .children(`via ${titleOf(trace, via)}`),
        ),
      ),
    );

const taskTitleOf = (trace: Trace, id: TaskId): string =>
  Option.match(
    Array.findFirst(trace.tasks, (task) => task.id === id),
    { onNone: () => id, onSome: (task) => `${id} ${task.title}` },
  );

/**
 * What follows an unfinished task in Next: `waits on t94` for one whose needs are unfinished, and
 * its status for one that is under way, blocked or failed with nothing left to wait on. A task that
 * can start needs no note.
 */
const nextNoteOf = (trace: Trace, next: NextTask): Option.Option<string> =>
  Array.match(next.waitsOn, {
    onEmpty: () =>
      next.canStart
        ? Option.none()
        : Option.map(
            Array.findFirst(trace.tasks, (task) => task.id === next.task),
            (task) => statusWordOf(task.status),
          ),
    onNonEmpty: (waits) => Option.some(`waits on ${Array.join(waits, ", ")}`),
  });

/** An unfinished task of the section: a button that opens its detail, then what it waits on or its status. */
const nextTaskView = (h: Html.H<Message>, trace: Trace, next: NextTask) =>
  h.li
    .key(next.task)
    .attr("data-link-task", next.task)
    .attr("data-can-start", `${next.canStart}`)
    .children(
      withHover(
        h.button
          .attr("type", "button")
          .class("btn link-entry")
          .on("click", Message.ClickedTask({ id: next.task })),
        { id: next.task, kind: "task" },
      ).children(taskTitleOf(trace, next.task)),
      Option.getOrUndefined(
        Option.map(nextNoteOf(trace, next), (note) =>
          h.span
            .class("link-note")
            .attr("data-link-waits", Array.isReadonlyArrayEmpty(next.waitsOn) ? undefined : "")
            .children(note),
        ),
      ),
    );

const groupView = <A>(
  h: Html.H<Message>,
  group: string,
  label: string,
  entries: ReadonlyArray<A>,
  entryView: (entry: A) => ReturnType<typeof linkedSectionView>,
) =>
  h.section
    .class("links-group")
    .attr("data-links-group", group)
    .children(
      labelView(h, label),
      Array.match(entries, {
        onEmpty: () => h.p.class("link-note").children("none"),
        onNonEmpty: (listed) => h.ul.children(Array.map(listed, entryView)),
      }),
    );

/**
 * The list under a heading or an item (see `spec.viewer.what-depends-on-what`): `Needs` and
 * `Needed by`, each section or item with its status dot and the pairs of tasks, and `Next`, the
 * section's unfinished tasks, the ones that can start first and each other one with what it waits
 * on. The switch asks for everything before and after, in build order, each with the link it comes through.
 */
export const linksView = (
  h: Html.H<Message>,
  trace: Trace,
  id: PrdSectionId,
  isTransitive: boolean,
) => {
  const links: SectionLinks = linksFor(trace, id, isTransitive);
  return h.div
    .class("links")
    .attr("role", "group")
    .attr("aria-label", `What ${id} needs and what needs it`)
    .attr("data-links", id)
    .children(
      switchView(h, {
        id: LINKS_SWITCH_ID,
        isChecked: isTransitive,
        label: "Everything before and after",
        onToggle: () => Message.ClickedLinksTransitiveSwitch(),
      }),
      groupView(h, "needs", "Needs", links.needs, (link) => linkedSectionView(h, trace, link)),
      groupView(h, "needed-by", "Needed by", links.neededBy, (link) =>
        linkedSectionView(h, trace, link),
      ),
      groupView(h, "next", "Next", links.next, (next) => nextTaskView(h, trace, next)),
    );
};
