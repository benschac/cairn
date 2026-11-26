import { Html } from "@effect/ui/html";
import { Array, Option, Schema } from "effect";
import { Url } from "foldkit";

import { viewerBridge } from "./effect-ui/viewerBridge.ts";
import { init } from "./init.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { subscriptions } from "./subscription/index.ts";
import { update, withAddress } from "./update.ts";
import { view } from "./view/view.ts";

export { viewerBridge };

const addressed = withAddress(update);

/**
 * The viewer as one Effect UI component (`spec.viewer.effect-ui.host`), with the Model, Messages,
 * `update` it had under Foldkit. Its one prop is the address it opens at; with none, as in a test,
 * it starts at `/`. Each Foldkit Command `init` or `update` returns runs through `$.run`. The view
 * is Effect UI's from the frame down; the views under it that have not moved render through the
 * bridge, in the one Foldkit pass `viewerBridge.render` opens around each render.
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
  view: (h, model) => viewerBridge.render(() => view(h, model)),
});
