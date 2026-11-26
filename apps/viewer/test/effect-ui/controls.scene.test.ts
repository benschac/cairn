import { UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { HtmlLocator, HtmlPlay, HtmlScene } from "@effect/ui/html/testing";
import { Locator, TestHost } from "@effect/ui/testing";
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  disclosurePanelId,
  disclosureView,
  switchLabelId,
  switchView,
} from "../../src/effect-ui/controls.ts";

// A small component hosts the switch and the disclosure the way a view will, as
// `ui.scene.test.ts` hosts the Foldkit ones: the state is its Model, and what a person does is a
// fact-named Message, whose text the view shows.

const Message = UiSchema.TaggedEnum({
  ClickedModelsSwitch: { isChecked: Schema.Boolean },
  ClickedSpecCard: { isOpen: Schema.Boolean },
});
type Message = typeof Message.Type;

const Model = Schema.Struct({
  isChecked: Schema.Boolean,
  isOpen: Schema.Boolean,
  /** The last Message the component received, as text. */
  sent: Schema.String,
});
type Model = typeof Model.Type;

const switchLabel = "Models and reasoning";

const Controls = Html.component({
  message: Message,
  model: Model,
  name: "Controls",
  props: Schema.Struct({ isChecked: Schema.Boolean, isOpen: Schema.Boolean }),
}).make({
  init: ($): Model => ({ isChecked: $.props.isChecked, isOpen: $.props.isOpen, sent: "" }),
  update: {
    ClickedModelsSwitch: ($, { isChecked }) =>
      $.evolve({ isChecked, sent: `ClickedModelsSwitch ${isChecked}` }),
    ClickedSpecCard: ($, { isOpen }) => $.evolve({ isOpen, sent: `ClickedSpecCard ${isOpen}` }),
  },
  view: (h, model) =>
    h.main.children(
      switchView(h, {
        id: "models",
        isChecked: model.isChecked,
        label: switchLabel,
        onToggle: (isChecked): Message => Message.ClickedModelsSwitch({ isChecked }),
      }),
      disclosureView(h, {
        id: "spec-card",
        isOpen: model.isOpen,
        onToggle: (isOpen): Message => Message.ClickedSpecCard({ isOpen }),
        view: (disclosure) =>
          h.article
            .class("card")
            .children(
              disclosure.button(h.button.class("card-head")).children("Spec card"),
              model.isOpen && disclosure.panel(h.div).children("The spec section in full"),
            ),
      }),
      h.p.id("sent").children(model.sent),
    ),
});

const closed = { isChecked: false, isOpen: false };

const modelsSwitch = HtmlLocator.role("switch", { name: switchLabel });
const specCardHeader = HtmlLocator.role("button", { name: "Spec card" });
const specCardPanel = Locator.attr("id", disclosurePanelId("spec-card"));
const sent = Locator.attr("id", "sent");

it.effect("clicking the switch sends its Message and sets aria-checked, and again unsets it", () =>
  Effect.gen(function* () {
    const s = yield* HtmlScene.make(Controls, closed);
    s.expect(modelsSwitch)
      .toHaveAttribute("aria-checked", "false")
      .expect(modelsSwitch)
      .toHaveAttribute("class", "btn")
      .expect(modelsSwitch)
      .toHaveAttribute("aria-labelledby", switchLabelId("models"))
      .click(modelsSwitch)
      .expect(sent)
      .toHaveText("ClickedModelsSwitch true")
      .expect(modelsSwitch)
      .toHaveAttribute("aria-checked", "true")
      .click(modelsSwitch)
      .expect(sent)
      .toHaveText("ClickedModelsSwitch false")
      .expect(modelsSwitch)
      .toHaveAttribute("aria-checked", "false");
  }),
);

it.effect(
  "the switch is a native button, so the browser turns Space and Enter into its click",
  () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(Controls, closed);
      s.expect(modelsSwitch).toHaveAttribute("type", "button");
      assert.strictEqual(s.get(modelsSwitch).tag, "button");
    }),
);

it.effect("a closed disclosure has aria-expanded false, no aria-controls and no panel", () =>
  Effect.gen(function* () {
    const s = yield* HtmlScene.make(Controls, closed);
    s.expect(specCardHeader)
      .toHaveAttribute("aria-expanded", "false")
      .expect(specCardHeader)
      .toHaveAttribute("aria-controls", false)
      .expect(specCardPanel)
      .toBeAbsent();
  }),
);

// The disclosure is a plain button whose click sends the component's own Message, so a Scene
// clicks it as a person does, and so does a Play.

it.effect("clicking the disclosure sends its Message and renders its panel", () =>
  Effect.gen(function* () {
    const s = yield* HtmlScene.make(Controls, closed);
    s.click(specCardHeader)
      .expect(sent)
      .toHaveText("ClickedSpecCard true")
      .expect(specCardHeader)
      .toHaveAttribute("aria-expanded", "true")
      .expect(specCardHeader)
      .toHaveAttribute("aria-controls", disclosurePanelId("spec-card"))
      .expect(specCardPanel)
      .toHaveText("The spec section in full");
  }),
);

it.layer(TestHost.layer(), { buildPerTest: true })("the disclosure in a Play", (withHost) => {
  withHost.effect(
    "opening a disclosure sets aria-expanded and aria-controls and renders its panel",
    () =>
      Effect.gen(function* () {
        const play = yield* HtmlPlay.make(Controls, closed);
        yield* play.click(specCardHeader);
        yield* play.expect(sent).toHaveText("ClickedSpecCard true");
        yield* play.expect(specCardHeader).toHaveAttribute("aria-expanded", "true");
        yield* play
          .expect(specCardHeader)
          .toHaveAttribute("aria-controls", disclosurePanelId("spec-card"));
        yield* play.expect(specCardPanel).toHaveText("The spec section in full");
        yield* play.click(specCardHeader);
        yield* play.expect(sent).toHaveText("ClickedSpecCard false");
        yield* play.expect(specCardHeader).toHaveAttribute("aria-expanded", "false");
        yield* play.expect(specCardPanel).toBeAbsent();
      }),
  );
});
