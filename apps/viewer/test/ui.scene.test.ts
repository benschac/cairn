import { SectionStatus } from "@cairn/contract";
import { Html } from "@effect/ui/html";
import { HtmlScene } from "@effect/ui/html/testing";
import { Locator } from "@effect/ui/testing";
import { it } from "@effect/vitest";
import { Array, Effect, Option, Record, Schema, String, pipe } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import { readFileSync } from "node:fs";
import { expect as assert } from "vitest";

import {
  disclosureView,
  segmentedView,
  switchView,
  type SegmentedOption,
} from "../src/effect-ui/controls.ts";
import { dotView, gateView, labelView, tagView, type TagKind } from "../src/ui/marks.ts";
import { both, byRole, containing, inside, withClass } from "./fixtures.ts";

// A small component hosts the three controls and the marks the way a view will: the state is its
// Model, and what a person does is a fact-named Message.

const Density = Schema.Literals(["titles", "summary", "full"]);
type Density = typeof Density.Type;

const Message = defineMessageUnion({
  ClickedDensity: { density: Density },
  ClickedModelsSwitch: { isChecked: Schema.Boolean },
  ClickedSpecCard: { isOpen: Schema.Boolean },
});
type Message = typeof Message.Type;

const Model = Schema.Struct({
  density: Density,
  isChecked: Schema.Boolean,
  isOpen: Schema.Boolean,
  /** The last Message the program received, as text. */
  sent: Schema.String,
});
type Model = typeof Model.Type;

const sentText = (message: Message): string =>
  Message.match(message, {
    ClickedDensity: ({ density }) => `ClickedDensity ${density}`,
    ClickedModelsSwitch: ({ isChecked }) => `ClickedModelsSwitch ${isChecked}`,
    ClickedSpecCard: ({ isOpen }) => `ClickedSpecCard ${isOpen}`,
  });

const applied = (model: Model, message: Message): Model =>
  Message.match(message, {
    ClickedDensity: ({ density }) => modifyFields(model, { density: () => density }),
    ClickedModelsSwitch: ({ isChecked }) => modifyFields(model, { isChecked: () => isChecked }),
    ClickedSpecCard: ({ isOpen }) => modifyFields(model, { isOpen: () => isOpen }),
  });

const densities: ReadonlyArray<SegmentedOption<Density>> = [
  { label: "Titles", value: "titles" },
  { label: "Summary", value: "summary" },
  { label: "Full spec", value: "full" },
];

const tagKinds: ReadonlyArray<TagKind> = ["prd", "spec", "task", "sha"];

const switchLabel = "Models and reasoning";
const groupLabel = "How much of the spec to show";

/** The program's view. */

const view = (h: Html.H<Message>, model: Model) =>
  h.main.children(
    switchView(h, {
      id: "models",
      isChecked: model.isChecked,
      label: switchLabel,
      onToggle: (isChecked) => Message.ClickedModelsSwitch({ isChecked }),
    }),
    segmentedView(h, {
      label: groupLabel,
      onSelect: (density: Density) => Message.ClickedDensity({ density }),
      options: densities,
      selected: model.density,
    }),
    disclosureView(h, {
      id: "spec-card",
      isOpen: model.isOpen,
      onToggle: (isOpen) => Message.ClickedSpecCard({ isOpen }),
      view: ({ button, panel }) =>
        h.article
          .class("card")
          .children(
            button(h.button.class("card-head")).children("Spec card"),
            model.isOpen && panel(h.div).children("The spec section in full"),
          ),
    }),
    h.div.id("marks").children(
      Array.map(SectionStatus.literals, (status) => dotView(h, status)),
      Array.map(tagKinds, (kind) => tagView(h, kind, `a ${kind}`)),
      gateView(h),
      labelView(h, "Stacks"),
    ),
    h.p.id("sent").children(model.sent),
  );

const Controls = Html.component({
  message: Message,
  model: Model,
  name: "Controls",
  props: Model,
}).make({
  init: ($) => $.props,
  update: ($, message) =>
    modifyFields(applied($.model, message), { sent: () => sentText(message) }),
  view,
});

const closed: Model = { density: "summary", isChecked: false, isOpen: false, sent: "" };
const start = (model: Model = closed) => HtmlScene.make(Controls, model);

const modelsSwitch = byRole("switch", { name: switchLabel });
const group = byRole("group", { name: groupLabel });
const densityButton = (name: string) => byRole("button", { name });
const specCardHeader = byRole("button", { name: "Spec card" });
const specCardPanel = Locator.attr("id", "spec-card-panel");
const sent = Locator.attr("id", "sent");
const marks = Locator.attr("id", "marks");

// The stylesheet, read as the design test reads it, so a mark is checked against what it selects.
const components = pipe(
  readFileSync(new URL("../src/ui/components.css", import.meta.url), "utf8"),
  String.replaceAll(/\/\*[\s\S]*?\*\//gu, ""),
);

/** The declarations of every rule whose selector list has `selectorText` in it. */
const declarationsOf = (selectorText: string): ReadonlyArray<string> =>
  pipe(
    Array.fromIterable(String.matchAll(/([^{}]+)\{([^{}]*)\}/gu)(components)),
    Array.filter((match) =>
      Option.exists(Array.get(match, 1), (selectors) =>
        Array.some(
          String.split(selectors, ","),
          (candidate) => String.trim(candidate) === selectorText,
        ),
      ),
    ),
    Array.flatMap((match) => Array.getSomes([Array.get(match, 2)])),
    Array.flatMap((body) => String.split(body, ";")),
    Array.map(String.trim),
    Array.filter(String.isNonEmpty),
  );

it.effect("clicking the switch sends its Message and sets aria-checked, and again unsets it", () =>
  Effect.gen(function* () {
    const s = yield* start();
    s.expect(modelsSwitch)
      .toHaveAttribute("aria-checked", "false")
      .expect(modelsSwitch)
      .toHaveAttribute("class", "btn")
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

/**
 * The switch toggles when Space is released. `HtmlScene` fires `keyup` with a key: Space is
 * handled, so it sends the opposite Message and cancels the key's default, and a key the switch
 * ignores does neither.
 */
it.effect.each([false, true])(
  "releasing Space on a switch that is checked: %s sends the opposite, and no other key does",
  (isChecked) =>
    Effect.gen(function* () {
      const s = yield* start(modifyFields(closed, { isChecked: () => isChecked }));
      s.fire(modelsSwitch, "keyup", { key: " " })
        .expectDefaultPrevented(true)
        .expect(sent)
        .toHaveText(`ClickedModelsSwitch ${!isChecked}`)
        .fire(modelsSwitch, "keyup", { key: "a" })
        .expectIgnored()
        .fire(modelsSwitch, "keyup", { key: "Enter" })
        .expectIgnored()
        .expect(sent)
        .toHaveText(`ClickedModelsSwitch ${!isChecked}`);
    }),
);

it.effect("a segmented control's options are buttons in a labelled group, and one is pressed", () =>
  Effect.gen(function* () {
    const s = yield* start();
    s.expect(group)
      .toExist()
      .expect(densityButton("Titles"))
      .toHaveAttribute("aria-pressed", "false")
      .expect(densityButton("Summary"))
      .toHaveAttribute("aria-pressed", "true")
      .expect(densityButton("Full spec"))
      .toHaveAttribute("aria-pressed", "false")
      .expect(group)
      .toHaveAttribute("class", "seg");
  }),
);

it.effect("clicking a segmented option sends it and aria-pressed moves to it", () =>
  Effect.gen(function* () {
    const s = yield* start();
    s.click(densityButton("Full spec"))
      .expect(sent)
      .toHaveText("ClickedDensity full")
      .expect(densityButton("Full spec"))
      .toHaveAttribute("aria-pressed", "true")
      .expect(densityButton("Summary"))
      .toHaveAttribute("aria-pressed", "false")
      .click(densityButton("Titles"))
      .expect(sent)
      .toHaveText("ClickedDensity titles")
      .expect(densityButton("Titles"))
      .toHaveAttribute("aria-pressed", "true")
      .expect(densityButton("Full spec"))
      .toHaveAttribute("aria-pressed", "false");
  }),
);

it.effect("a closed disclosure has aria-expanded false, no aria-controls and no panel", () =>
  Effect.gen(function* () {
    const s = yield* start();
    s.expect(specCardHeader)
      .toHaveAttribute("aria-expanded", "false")
      .expect(specCardHeader)
      .toHaveAttribute("aria-controls", false)
      .expect(specCardPanel)
      .toBeAbsent();
  }),
);

it.effect("opening a disclosure sets aria-expanded and aria-controls and renders its panel", () =>
  Effect.gen(function* () {
    const s = yield* start();
    s.click(specCardHeader)
      .expect(sent)
      .toHaveText("ClickedSpecCard true")
      .expect(specCardHeader)
      .toHaveAttribute("aria-expanded", "true")
      .expect(specCardHeader)
      .toHaveAttribute("aria-controls", "spec-card-panel")
      .expect(specCardPanel)
      .toHaveText(containing("The spec section in full"))
      .click(specCardHeader)
      .expect(sent)
      .toHaveText("ClickedSpecCard false")
      .expect(specCardHeader)
      .toHaveAttribute("aria-expanded", "false")
      .expect(specCardPanel)
      .toBeAbsent();
  }),
);

it.effect("a disclosure also opens on Enter and on Space", () =>
  Effect.gen(function* () {
    const s = yield* start();
    s.keydown(specCardHeader, "Enter")
      .expect(specCardHeader)
      .toHaveAttribute("aria-expanded", "true")
      .keydown(specCardHeader, " ")
      .expect(specCardHeader)
      .toHaveAttribute("aria-expanded", "false");
  }),
);

// What the controls draw is what the stylesheet selects, and the stylesheet gives it its fill.
it.each([
  ['.btn[aria-checked="true"]'],
  ['.btn[aria-pressed="true"]'],
  ['.seg > button[aria-pressed="true"]'],
])("components.css fills %s with --green", (selectorText) => {
  assert(declarationsOf(selectorText)).toContain("background-color: var(--green)");
});

it.effect.each(SectionStatus.literals)(
  "a dot of status %s carries data-status, which components.css colours as the spec's table says",
  (status) =>
    Effect.gen(function* () {
      const tokenOf: Record.ReadonlyRecord<string, string> = {
        blocked_on_human: "--blocked",
        done: "--done",
        failed: "--blocked",
        in_progress: "--progress",
        landed: "--done",
        running: "--progress",
      };
      const s = yield* start();
      s.expect(
        inside(marks, both(withClass("dot"), Locator.attr("data-status", status))),
      ).toExist();
      Option.match(Record.get(tokenOf, status), {
        onNone: () => {
          assert(declarationsOf(".dot")).toContain("background-color: var(--pending)");
          assert(declarationsOf(`.dot[data-status="${status}"]`)).toEqual([]);
        },
        onSome: (token) =>
          assert(declarationsOf(`.dot[data-status="${status}"]`)).toEqual([
            `background-color: var(${token})`,
          ]),
      });
    }),
);

it.effect.each(tagKinds)("a %s tag carries data-kind and its text", (kind) =>
  Effect.gen(function* () {
    const s = yield* start();
    s.expect(inside(marks, both(withClass("tag"), Locator.attr("data-kind", kind)))).toHaveText(
      `a ${kind}`,
    );
  }),
);

it("components.css fills a PRD tag and a spec tag, and leaves a task ID and a SHA --raised", () => {
  assert(declarationsOf('.tag[data-kind="prd"]')).toEqual(["background-color: var(--prd)"]);
  assert(declarationsOf('.tag[data-kind="spec"]')).toEqual(["background-color: var(--spec)"]);
  assert(declarationsOf('.tag[data-kind="task"]')).toEqual([]);
  assert(declarationsOf('.tag[data-kind="sha"]')).toEqual([]);
  assert(declarationsOf(".tag")).toContain("background-color: var(--raised)");
});

it.effect("GATE and a label render the classes the stylesheet gives their look", () =>
  Effect.gen(function* () {
    const s = yield* start();
    s.expect(withClass("gate")).toHaveText("GATE").expect(withClass("label")).toHaveText("Stacks");
    assert(declarationsOf(".gate")).toContain("color: var(--blocked-ink)");
    assert(declarationsOf(".label")).toContain("text-transform: uppercase");
  }),
);
