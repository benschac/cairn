import type { Trace } from "@cairn/contract";
import { Array, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { focusTaskOf } from "../arrows.ts";
import { Message } from "../message.ts";
import type { Destination, Model } from "../model.ts";
import { currentOf, searchedSectionOf } from "../reader.ts";
import { Resize } from "../panes.ts";
import { switchView } from "../ui/controls.ts";
import { detailView } from "./detailView.ts";
import { linkNoticeView } from "./linkNoticeView.ts";
import { dividerView, DIVIDER_WIDTH, STACKS_HANDLE_WIDTH } from "./dividerView.ts";
import { prdPaneView } from "./prdPaneView.ts";
import { searchView } from "./searchView.ts";
import { specPaneView } from "./specPaneView.ts";
import { stackChipsView } from "./stackChipsView.ts";
import { MeasureWires, WIRES_ATTRIBUTE, wiresView } from "./wiresView.ts";

/**
 * The "Plan" and "Canvas" pair, until the canvas is removed: it moves between the two screens, so
 * the reader can be tried on the demo as it is built.
 */
const SCREENS: ReadonlyArray<{
  readonly label: string;
  readonly value: Destination;
}> = [
  { label: "Plan", value: "Reader" },
  { label: "Canvas", value: "Canvas" },
];

/**
 * The screen you are on is marked `aria-current`, not pressed: a screen is moved to, not toggled,
 * and the canvas counts the pressed buttons for its pinned nodes.
 */
export const screenSwitchView = (selected: Destination, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("seg"), h.Role("group"), h.AriaLabel("Screen")],
    Array.map(SCREENS, ({ label, value }) =>
      h.button(
        Array.appendAll(
          [h.Type("button"), h.OnClick(Message.ClickedScreen({ screen: value }))],
          value === selected ? [h.AriaCurrent("page")] : [],
        ),
        [label],
      ),
    ),
  );

const cairnLogoView = (h: HtmlBuilder<Message>): Html =>
  h.svg(
    [h.Width("20"), h.Height("20"), h.ViewBox("0 0 22 22"), h.AriaHidden(true)],
    [
      h.ellipse([
        h.Cx("11"),
        h.Cy("18"),
        h.Rx("9"),
        h.Ry("3.2"),
        h.Fill("currentColor"),
        h.Opacity("0.9"),
      ]),
      h.ellipse([
        h.Cx("11"),
        h.Cy("12.2"),
        h.Rx("6.5"),
        h.Ry("2.8"),
        h.Fill("currentColor"),
        h.Opacity("0.7"),
      ]),
      h.ellipse([
        h.Cx("11"),
        h.Cy("7.2"),
        h.Rx("4.2"),
        h.Ry("2.3"),
        h.Fill("currentColor"),
        h.Opacity("0.5"),
      ]),
      h.ellipse([
        h.Cx("11"),
        h.Cy("3.4"),
        h.Rx("2.2"),
        h.Ry("1.5"),
        h.Fill("currentColor"),
        h.Opacity("0.35"),
      ]),
    ],
  );

const topBarView = (trace: Trace, model: Model, presence: string, h: HtmlBuilder<Message>): Html =>
  h.header(
    [
      h.Class("topbar"),
      h.DataAttribute("topbar", ""),
      h.Style({ position: "relative", "z-index": "10" }),
    ],
    [
      h.span(
        [h.Class("topbar-brand")],
        [cairnLogoView(h), h.h1([h.Style({ "font-size": "var(--t-xl)", margin: "0" })], ["Cairn"])],
      ),
      h.span([h.DataAttribute("feature", "")], [trace.feature]),
      screenSwitchView("Reader", h),
      searchView(trace, model.search, h),
      switchView(
        {
          id: "models-switch",
          isChecked: model.isShowingModels,
          label: "Models and reasoning",
          onToggle: () => Message.ClickedModelsSwitch(),
        },
        h,
      ),
      h.p([h.Role("status")], [presence]),
    ],
  );

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

/** The least empty room after the stacks pane's handle, in pixels. */
export const TRAILING_ROOM = 320;

/**
 * The plan screen: a top bar over the panes. The window does not scroll; each pane has its own
 * scroll. The current section is the active search result's first PRD section, else the pinned
 * one, else the one at the top. The panes preview a chain as a hover does: the hovered node's, and
 * the active result's while nothing is hovered.
 */
export const readerView = (
  trace: Trace,
  model: Model,
  presence: string,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeCurrent = currentOf(model.reader, searchedSectionOf(trace, model.search.maybeActive));
  const maybePreview = Option.orElse(model.maybeHovered, () => model.search.maybeActive);
  return h.div(
    [
      h.Class("reader"),
      h.DataAttribute("reader", ""),
      h.Style({
        display: "grid",
        flex: "1",
        "grid-template-columns": "minmax(0, 1fr)",
        "grid-template-rows": "auto minmax(0, 1fr)",
        "min-height": "0",
        "min-width": "0",
        overflow: "hidden",
      }),
    ],
    Array.appendAll(
      [
        // The notice sits under the top bar, in the grid's first row.
        h.div(
          [],
          Array.appendAll(
            [topBarView(trace, model, presence, h)],
            Option.match(model.maybeLinkNotice, {
              onNone: () => [],
              onSome: (text) => [
                linkNoticeView(text, h, {
                  onDismiss: Message.ClickedDismissLinkNotice(),
                }),
              ],
            }),
          ),
        ),
        h.div(
          [
            h.Style({
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
            h.Class("reader-row"),
            h.DataAttribute("reader-grid", ""),
            h.OnMount(MeasureWires()),
            // What changes the layout without changing a size the mount's observers see: the
            // current section, whether the model chips wrap the rows, and the unfolded trunks.
            h.Attribute(
              WIRES_ATTRIBUTE,
              wiresAttributeOf(maybeCurrent, model.isShowingModels, model.reader.unfolded),
            ),
          ],
          [
            prdPaneView(
              trace,
              maybeCurrent,
              model.reader.maybePinned,
              model.reader.isPrdCondensed,
              model.reader.prdOpened,
              model.maybeCopied,
              model.search.results,
              model.search.maybeActive,
              model.readers,
              h,
            ),
            dividerView("prd", model.widths, h),
            specPaneView(
              trace,
              maybeCurrent,
              model.reader,
              model.isShowingModels,
              maybePreview,
              model.search.results,
              model.search.maybeActive,
              h,
            ),
            dividerView("spec", model.widths, h),
            stackChipsView(
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
              h,
            ),
            dividerView("stacks", model.widths, h),
            wiresView(
              trace,
              maybeCurrent,
              model.maybeMeasuredWires,
              maybePreview,
              model.reader.unfolded,
              h,
            ),
          ],
        ),
      ],
      Array.match(model.detail, {
        onEmpty: () => [],
        onNonEmpty: (trail) => [
          detailView(trace, trail, model.widths, model.patches, model.diffStyle, h),
        ],
      }),
    ),
  );
};
