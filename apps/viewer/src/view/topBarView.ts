import type { Trace } from "@cairn/contract";
import type { Html } from "@effect/ui/html";

import { switchView } from "../effect-ui/controls.ts";
import { styleText } from "../effect-ui/attributes.ts";
import { svgFor } from "../effect-ui/svg.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { searchView } from "./searchView.ts";

const svg = svgFor<Message>();

/** One stone of the logo: an ellipse, more opaque the lower it sits. */
const stoneView = (cy: string, rx: string, ry: string, opacity: string) =>
  svg.ellipse
    .attr("cx", "11")
    .attr("cy", cy)
    .attr("rx", rx)
    .attr("ry", ry)
    .attr("fill", "currentColor")
    .attr("opacity", opacity);

/** Four stones stacked, in the text's colour. */
const cairnLogoView = () =>
  svg.svg
    .attr("width", "20")
    .attr("height", "20")
    .attr("viewBox", "0 0 22 22")
    .attr("aria-hidden", "true")
    .children(
      stoneView("18", "9", "3.2", "0.9"),
      stoneView("12.2", "6.5", "2.8", "0.7"),
      stoneView("7.2", "4.2", "2.3", "0.5"),
      stoneView("3.4", "2.2", "1.5", "0.35"),
    );

/**
 * The bar over the reader: the logo and name, the feature the trace plans, the search, the models
 * switch and who else is here.
 */
export const topBarView = (h: Html.H<Message>, trace: Trace, model: Model, presence: string) =>
  h.header
    .class("topbar")
    .attr("data-topbar", "")
    .attr("style", styleText({ position: "relative", "z-index": "10" }))
    .children(
      h.span
        .class("topbar-brand")
        .children(
          cairnLogoView(),
          h.h1
            .attr("style", styleText({ "font-size": "var(--t-xl)", margin: "0" }))
            .children("Cairn"),
        ),
      h.span.attr("data-feature", "").children(trace.feature),
      searchView(h, trace, model.search),
      switchView(h, {
        id: "models-switch",
        isChecked: model.isShowingModels,
        label: "Models and reasoning",
        onToggle: () => Message.ClickedModelsSwitch(),
      }),
      h.p.attr("role", "status").children(presence),
    );
