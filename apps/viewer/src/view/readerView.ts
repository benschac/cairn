import { PrdSectionId, type Trace } from "@cairn/contract";
import { Array, Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../message.ts";
import type { Destination, Model } from "../model.ts";
import { currentOf } from "../reader.ts";
import { Resize, limitsOf } from "../panes.ts";
import { Node } from "../trace.ts";
import { switchView } from "../ui/controls.ts";
import { detailView } from "./detailView.ts";
import { dividerView, DIVIDER_WIDTH } from "./dividerView.ts";
import { prdPaneView } from "./prdPaneView.ts";
import { searchView } from "./searchView.ts";
import { specPaneView } from "./specPaneView.ts";
import { stackChipsView } from "./stackChipsView.ts";
import { MeasureWires, WIRES_ATTRIBUTE, wiresView } from "./wiresView.ts";

const isPrdSection = Schema.is(PrdSectionId);

/** The PRD section the active search result is, when it is one. */
const searchedOf = (model: Model): Option.Option<PrdSectionId> =>
  Option.flatMap(model.search.maybeActive, (node) =>
    Node.match(node, {
      section: ({ id }) => Option.liftPredicate(id, isPrdSection),
      task: () => Option.none(),
    }),
  );

/**
 * The "Plan" and "Canvas" pair, until the canvas is removed: it moves between the two screens, so
 * the reader can be tried on the demo as it is built.
 */
const SCREENS: ReadonlyArray<{ readonly label: string; readonly value: Destination }> = [
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

const topBarView = (trace: Trace, model: Model, presence: string, h: HtmlBuilder<Message>): Html =>
  h.header(
    [
      h.Class("topbar"),
      h.DataAttribute("topbar", ""),
      h.Style({ position: "relative", "z-index": "10" }),
    ],
    [
      h.h1([h.Style({ "font-size": "var(--t-xl)", margin: "0" })], ["Cairn"]),
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
      h.p([h.Role("status"), h.Style({ margin: "0 0 0 auto" })], [presence]),
    ],
  );

/**
 * The plan screen: a top bar over the panes. The window does not scroll; each pane has its own
 * scroll. The current section is the search result's, else the pinned one, else the one at the top.
 */
export const readerView = (
  trace: Trace,
  model: Model,
  presence: string,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeCurrent = currentOf(model.reader, searchedOf(model));
  return h.div(
    [
      h.Class("reader"),
      h.DataAttribute("reader", ""),
      h.Style({
        display: "grid",
        flex: "1",
        "grid-template-rows": "auto minmax(0, 1fr)",
        "min-height": "0",
      }),
    ],
    Array.appendAll(
      [
        topBarView(trace, model, presence, h),
        h.div(
          [
            h.Style({
              display: "grid",
              // The widths are what a person chose; the columns give each pane up to that, and
              // down to its least before the stacks pane goes under 240px.
              "--prd-width": `${model.widths.prd}px`,
              "--spec-width": `${model.widths.spec}px`,
              "grid-template-columns": `minmax(${limitsOf("prd").min}px, var(--prd-width)) ${DIVIDER_WIDTH}px minmax(${limitsOf("spec").min}px, var(--spec-width)) ${DIVIDER_WIDTH}px minmax(240px, 1fr)`,
              "grid-template-rows": "minmax(0, 1fr)",
              "min-height": "0",
              // Narrower than every least width and both dividers, the reader scrolls sideways.
              "overflow-x": "auto",
              "overflow-y": "hidden",
              "user-select": Resize.guards.Resizing(model.resize) ? "none" : "auto",
            }),
            h.DataAttribute("reader-grid", ""),
            h.OnMount(MeasureWires()),
            // What changes the layout without changing a size the mount's observers see: the
            // current section, and whether the model chips wrap the rows.
            h.Attribute(
              WIRES_ATTRIBUTE,
              `${Option.getOrElse(maybeCurrent, () => "")}|${model.isShowingModels ? "models" : "plain"}`,
            ),
          ],
          [
            prdPaneView(trace, maybeCurrent, model.reader.maybePinned, model.maybeCopied, h),
            dividerView("prd", model.widths, h),
            specPaneView(
              trace,
              maybeCurrent,
              model.reader,
              model.isShowingModels,
              model.maybeHovered,
              h,
            ),
            dividerView("spec", model.widths, h),
            stackChipsView(trace, maybeCurrent, model.isShowingModels, model.maybeHovered, h),
            wiresView(trace, maybeCurrent, model.maybeMeasuredWires, model.maybeHovered, h),
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
