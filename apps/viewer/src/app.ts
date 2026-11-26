import { Html } from "@effect/ui/html";
import { Array, Option, Schema } from "effect";

import { init } from "./init.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { subscriptions } from "./subscription/index.ts";
import { update, withAddress, type Return } from "./update.ts";
import { Url } from "./url.ts";
import { view } from "./view/view.ts";

const addressed = withAddress(update);

/**
 * The viewer as one Effect UI component (`spec.viewer.effect-ui`). Its one prop is the address it
 * opens at; with none, as in a test, it starts at `/`. `init` and `update` say what the Model
 * becomes and which Commands run, and each step sets that Model and runs each Command with `$.run`.
 */
export const Viewer = Html.component({
  message: Message,
  model: Model,
  name: "Viewer",
  props: Schema.Struct({ maybeUrl: Schema.Option(Url) }),
}).make({
  init: ($) => {
    const { commands, model }: Return = init(Option.getOrUndefined($.props.maybeUrl));
    return Array.reduce(
      Option.getOrElse(Option.fromUndefinedOr(commands), Array.empty),
      $.set(model),
      (step, command) => step.run(command),
    );
  },
  update: ($, message) => {
    const { commands, model } = addressed($.model, message);
    return Array.reduce(
      Option.getOrElse(Option.fromUndefinedOr(commands), Array.empty),
      $.set(model),
      (step, command) => step.run(command),
    );
  },
  subscriptions,
  view,
});
