import { View } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Array, Option, Schema } from "effect";
import { Url } from "foldkit";

import { DrawDiagram } from "./diagram.ts";
import { RenderDiff } from "./diff.ts";
import { makeFoldkitBridge } from "./effect-ui/bridge.ts";
import { init } from "./init.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { subscriptions } from "./subscription/index.ts";
import { update, withAddress } from "./update.ts";
import { dividerHostMount } from "./view/dividerView.ts";
import { TrackPrdScroll } from "./view/prdPaneView.ts";
import { ScrollStacksToBottom } from "./view/stackChipsView.ts";
import { view } from "./view/view.ts";
import { MeasureWires } from "./view/wiresView.ts";

/**
 * The bridge the viewer's Foldkit views render through: every Foldkit Mount they issue, and the
 * dividers' press as an Effect UI mount.
 */
export const viewerBridge = makeFoldkitBridge({
  hostMounts: [dividerHostMount],
  message: Message,
  mounts: [DrawDiagram, MeasureWires, RenderDiff, ScrollStacksToBottom, TrackPrdScroll],
});

const addressed = withAddress(update);

/**
 * The viewer as one Effect UI component (`spec.viewer.effect-ui.host`), with the Model, Messages,
 * `update` and views it had under Foldkit. Its one prop is the address it opens at; with none, as
 * in a test, it starts at `/`. Each Foldkit Command `init` or `update` returns runs through
 * `$.run`, and the view is the Foldkit view through the bridge.
 */
export const Viewer = Html.component({
  message: Message,
  model: Model,
  name: "Viewer",
  props: Schema.Struct({ maybeUrl: Schema.Option(Url.Url) }),
}).make({
  init: ($) => {
    const { commands, model } = init(Option.getOrUndefined($.props.maybeUrl));
    return Array.reduce(
      Option.getOrElse(Option.fromUndefinedOr(commands), Array.empty),
      $.set(model),
      (step, command) => step.run(viewerBridge.command(command)),
    );
  },
  update: ($, message) => {
    const { commands, model } = addressed($.model, message);
    return Array.reduce(
      Option.getOrElse(Option.fromUndefinedOr(commands), Array.empty),
      $.set(model),
      (step, command) => step.run(viewerBridge.command(command)),
    );
  },
  subscriptions,
  // A Foldkit body is always an element; `null` would be Foldkit's empty view.
  view: (h, model) =>
    Option.getOrElse(
      Option.fromNullOr(
        viewerBridge.foldkitView(
          h,
          viewerBridge.build((foldkit) => view(model, foldkit).body),
        ),
      ),
      () => View.text(""),
    ),
});
