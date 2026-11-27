import type { Trace } from "@cairn/contract";
import type { Html } from "@effect/ui/html";
import { Array, Option, Record } from "effect";

import { focusTaskOf } from "../arrows.ts";
import { styleText } from "../effect-ui/attributes.ts";
import { linkOf, passageButtonOf, pathOfLink, trailLinkOf } from "../links.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { currentOf, searchedSectionOf } from "../reader.ts";
import { markedItemsOf } from "../trace.ts";
import { Resize } from "../panes.ts";
import { detailView } from "./detailView.ts";
import { linkNoticeView } from "./linkNoticeView.ts";
import { dividerView, DIVIDER_WIDTH, STACKS_HANDLE_WIDTH } from "./dividerView.ts";
import { prdPaneView } from "./prdPaneView.ts";
import { specPaneView } from "./specPaneView.ts";
import { stackChipsView } from "./stackChipsView.ts";
import { topBarView } from "./topBarView.ts";
import { MeasureWires, WIRES_ATTRIBUTE, wiresView } from "./wiresView.ts";

/** The roots of the stacks whose trunk is open. */
const unfoldedRootsOf = (unfolded: Record.ReadonlyRecord<string, boolean>): ReadonlyArray<string> =>
  Record.keys(Record.filter(unfolded, (isUnfolded) => isUnfolded));

/** What the body's `data-wires` holds: the current section, the chip style and the unfolded roots. */
const wiresAttributeOf = (
  maybeCurrent: Option.Option<string>,
  isShowingModels: boolean,
  unfolded: Record.ReadonlyRecord<string, boolean>,
): string =>
  Array.join(
    Array.appendAll(
      [Option.getOrElse(maybeCurrent, () => ""), isShowingModels ? "models" : "plain"],
      Array.match(unfoldedRootsOf(unfolded), {
        onEmpty: () => [],
        onNonEmpty: (roots) => [Array.join(roots, " ")],
      }),
    ),
    "|",
  );

/**
 * The IDs the PRD pane marks, as one string so the pane's memoised body compares it by value: the
 * section or item a spec card's chip named, and the items a hovered task builds.
 */
const markedOf = (trace: Trace, model: Model): string =>
  Array.join(
    Array.appendAll(
      Option.toArray(model.reader.maybeMarked),
      markedItemsOf(trace, model.maybeHovered),
    ),
    " ",
  );

/** The least empty room after the stacks pane's handle, in pixels. */
export const TRAILING_ROOM = 320;

/**
 * The plan screen: a top bar over the panes. The window does not scroll; each pane has its own
 * scroll. The current section is the active search result's first PRD section, else the pinned
 * one, else the one at the top. The panes preview a chain as a hover does: the hovered node's, and
 * the active result's while nothing is hovered.
 *
 * Every pane is Effect UI (`spec.viewer.effect-ui.views`). The grid's `MeasureWires` is an Effect UI mount.
 */
export const readerView = (h: Html.H<Message>, trace: Trace, model: Model, presence: string) => {
  const maybeCurrent = currentOf(model.reader, searchedSectionOf(trace, model.search.maybeActive));
  const maybePreview = Option.orElse(model.maybeHovered, () => model.search.maybeActive);
  // The pinned section's link up to its step: the pin's step is the link's first.
  const pinnedPath = Option.match(model.reader.maybePinned, {
    onNone: () => "",
    onSome: () => pathOfLink(Array.take(linkOf(model), 1)),
  });
  // The selection's button is given to the panes as plain values, so a pane that memoizes its
  // body is rebuilt when the button changes and not each time the selection grows.
  const maybePassageButton = passageButtonOf(trace, model.maybeSelectedPassage);
  const selectedSection: string = Option.match(maybePassageButton, {
    onNone: () => "",
    onSome: (button) => button.section,
  });
  const isSelectionOverLimit = Option.exists(maybePassageButton, (button) => button.isOverLimit);
  return h.div
    .class("reader")
    .attr("data-reader", "")
    .attr(
      "style",
      styleText({
        display: "grid",
        flex: "1",
        "grid-template-columns": "minmax(0, 1fr)",
        "grid-template-rows": "auto minmax(0, 1fr)",
        "min-height": "0",
        "min-width": "0",
        overflow: "hidden",
      }),
    )
    .children(
      // The notice sits under the top bar, in the grid's first row.
      h.div(
        topBarView(h, trace, model, presence),
        Option.getOrUndefined(
          Option.map(model.maybeLinkNotice, (text) =>
            linkNoticeView(h, text, { onDismiss: Message.ClickedDismissLinkNotice() }),
          ),
        ),
      ),
      h.div
        .attr(
          "style",
          styleText({
            display: "grid",
            // The widths are what a person chose, and the columns hold them, side by side as
            // columns in a deck: a window too narrow for them scrolls the reader sideways, and
            // the room after the stacks pane is never less than TRAILING_ROOM, so its handle
            // never reaches the window's edge: scroll right and it can be dragged further.
            "--prd-width": `${model.widths.prd}px`,
            "--spec-width": `${model.widths.spec}px`,
            "--stacks-width": `${model.widths.stacks}px`,
            "grid-template-columns": `var(--prd-width) ${DIVIDER_WIDTH}px var(--spec-width) ${DIVIDER_WIDTH}px var(--stacks-width) ${STACKS_HANDLE_WIDTH}px minmax(${TRAILING_ROOM}px, 1fr)`,
            "grid-template-rows": "minmax(0, 1fr)",
            "min-height": "0",
            "overflow-x": "auto",
            "overflow-y": "hidden",
            "user-select": Resize.guards.Resizing(model.resize) ? "none" : "auto",
          }),
        )
        .class("reader-row")
        .attr("data-reader-grid", "")
        // What changes the layout without changing a size the mount's observers see: the
        // current section, whether the model chips wrap the rows, and the unfolded trunks.
        .attr(
          WIRES_ATTRIBUTE,
          wiresAttributeOf(maybeCurrent, model.isShowingModels, model.reader.unfolded),
        )
        .onMount(MeasureWires())
        .children(
          prdPaneView(
            h,
            trace,
            maybeCurrent,
            model.reader.maybePinned,
            model.reader.isPrdCondensed,
            model.reader.prdOpened,
            model.maybeCopied,
            model.maybeCopiedLink,
            pinnedPath,
            model.search.results,
            model.search.maybeActive,
            model.reader.maybePassage,
            selectedSection,
            isSelectionOverLimit,
            model.readers,
            markedOf(trace, model),
          ),
          dividerView(h, "prd", model.widths),
          specPaneView(
            h,
            trace,
            maybeCurrent,
            model.reader,
            model.isShowingModels,
            maybePreview,
            model.search.results,
            model.search.maybeActive,
            model.maybeCopiedLink,
            selectedSection,
            isSelectionOverLimit,
          ),
          dividerView(h, "spec", model.widths),
          stackChipsView(
            h,
            trace,
            maybeCurrent,
            model.isShowingModels,
            model.reader.unfolded,
            model.maybeMeasuredWires,
            Array.last(model.detail),
            maybePreview,
            focusTaskOf(model),
            model.search.results,
            model.search.maybeActive,
            model.reader.maybeFocus,
            model.maybeCopiedLink,
          ),
          dividerView(h, "stacks", model.widths),
          wiresView(
            h,
            trace,
            maybeCurrent,
            model.maybeMeasuredWires,
            maybePreview,
            model.reader.unfolded,
          ),
        ),
      Array.match(model.detail, {
        onEmpty: () => null,
        onNonEmpty: (trail) =>
          detailView(h, trace, trail, model.widths, model.patches, model.diffStyle, {
            maybeCopied: model.maybeCopiedLink,
            trailPaths: Array.map(trail, (_, index) => pathOfLink(trailLinkOf(model, index))),
          }),
      }),
    );
};
