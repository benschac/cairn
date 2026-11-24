import { SectionStatus } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Array, Function, Option, Predicate, Record, Schema, String, pipe } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  click,
  expect,
  getByRole,
  given,
  keydown,
  role,
  scene,
  selector,
  tap,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { readFileSync } from "node:fs";
import { expect as assert } from "vitest";

import {
  disclosureView,
  segmentedView,
  switchView,
  type SegmentedOption,
} from "../src/ui/controls.ts";
import { dotView, gateView, labelView, tagView, type TagKind } from "../src/ui/marks.ts";

// A small program hosts the three controls and the marks the way a view will: the state is its
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

const update = (model: Model, message: Message) => ({
  model: modifyFields(applied(model, message), { sent: () => sentText(message) }),
});

const densities: ReadonlyArray<SegmentedOption<Density>> = [
  { label: "Titles", value: "titles" },
  { label: "Summary", value: "summary" },
  { label: "Full spec", value: "full" },
];

const tagKinds: ReadonlyArray<TagKind> = ["prd", "spec", "task", "sha"];

const switchLabel = "Models and reasoning";
const groupLabel = "How much of the spec to show";

/** The program's view; `observe` hears each Message the switch's `onToggle` builds. */
const viewObserving =
  (observe: (message: Message) => void) =>
  (model: Model, h: HtmlBuilder<Message>): Html =>
    h.main(
      [],
      [
        switchView(
          {
            id: "models",
            isChecked: model.isChecked,
            label: switchLabel,
            onToggle: (isChecked) => {
              const message = Message.ClickedModelsSwitch({ isChecked });
              observe(message);
              return message;
            },
          },
          h,
        ),
        segmentedView(
          {
            label: groupLabel,
            onSelect: (density) => Message.ClickedDensity({ density }),
            options: densities,
            selected: model.density,
          },
          h,
        ),
        disclosureView(
          {
            id: "spec-card",
            isOpen: model.isOpen,
            onToggle: (isOpen) => Message.ClickedSpecCard({ isOpen }),
            toView: ({ button, panel }) =>
              h.article(
                [h.Class("card")],
                Array.prepend(
                  model.isOpen ? [h.div(panel, ["The spec section in full"])] : [],
                  h.button(Array.prepend(button, h.Class("card-head")), ["Spec card"]),
                ),
              ),
          },
          h,
        ),
        h.div(
          [h.Id("marks")],
          Array.flatten([
            Array.map(SectionStatus.literals, (status) => dotView(status, h)),
            Array.map(tagKinds, (kind) => tagView(kind, `a ${kind}`, h)),
            [gateView(h), labelView("Stacks", h)],
          ]),
        ),
        h.p([h.Id("sent")], [model.sent]),
      ],
    );

const view = viewObserving(Function.constVoid);

const closed: Model = { density: "summary", isChecked: false, isOpen: false, sent: "" };
const start = (model: Model = closed) => given<Model>(model);

const modelsSwitch = role("switch", { name: switchLabel });
const group = role("group", { name: groupLabel });
const densityButton = (name: string) => role("button", { name });
const specCardHeader = role("button", { name: "Spec card" });
const specCardPanel = selector("#spec-card-panel");
const sent = selector("#sent");

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

it("clicking the switch sends its Message and sets aria-checked, and again unsets it", () => {
  scene(
    { update, view },
    start(),
    expect(modelsSwitch).toHaveAttr("aria-checked", "false"),
    expect(modelsSwitch).toHaveClass("btn"),
    click(modelsSwitch),
    expect(sent).toHaveText("ClickedModelsSwitch true"),
    expect(modelsSwitch).toHaveAttr("aria-checked", "true"),
    click(modelsSwitch),
    expect(sent).toHaveText("ClickedModelsSwitch false"),
    expect(modelsSwitch).toHaveAttr("aria-checked", "false"),
  );
});

interface Release {
  readonly key: string;
  readonly isPrevented: boolean;
  /** The Messages `onToggle` built while the key's handler ran. */
  readonly built: ReadonlyArray<Message>;
}

/**
 * `foldkit/scene` has `keydown` and no `keyup`, and the switch toggles when Space is released.
 * So this step reads the switch's `keyup` handler off the rendered view and calls it with the
 * key. A key the switch handles has its default prevented and builds the Message through
 * `onToggle`; one it ignores does neither.
 */
const releasing = (key: string, observed: ReadonlyArray<Message>, releases: Array<Release>) =>
  tap<Model, Message>(({ html }) => {
    const node = Option.getOrThrow(getByRole("switch", { name: switchLabel })(html));
    // A listener is one function; the view never gives an element a list of them.
    const listener = Option.getOrThrow(
      Option.filter(Option.fromNullishOr(node.data?.on?.["keyup"]), Predicate.isFunction),
    );
    const before = Array.length(observed);
    const prevented: Array<string> = [];
    Reflect.apply(listener, node, [
      {
        altKey: false,
        ctrlKey: false,
        key,
        metaKey: false,
        preventDefault: () => prevented.push(key),
        shiftKey: false,
      },
      node,
    ]);
    releases.push({
      built: Array.drop(observed, before),
      isPrevented: Array.isReadonlyArrayNonEmpty(prevented),
      key,
    });
  });

it.each([false, true])(
  "releasing Space on a switch that is checked: %s sends the opposite, and no other key does",
  (isChecked) => {
    const observed: Array<Message> = [];
    const releases: Array<Release> = [];
    scene(
      { update, view: viewObserving((message) => observed.push(message)) },
      start(modifyFields(closed, { isChecked: () => isChecked })),
      releasing(" ", observed, releases),
      releasing("a", observed, releases),
      releasing("Enter", observed, releases),
    );
    assert(releases).toEqual([
      {
        built: [Message.ClickedModelsSwitch({ isChecked: !isChecked })],
        isPrevented: true,
        key: " ",
      },
      { built: [], isPrevented: false, key: "a" },
      { built: [], isPrevented: false, key: "Enter" },
    ]);
  },
);

it("a segmented control's options are buttons in a labelled group, and one is pressed", () => {
  scene(
    { update, view },
    start(),
    expect(group).toExist(),
    expect(densityButton("Titles")).toHaveAttr("aria-pressed", "false"),
    expect(densityButton("Summary")).toHaveAttr("aria-pressed", "true"),
    expect(densityButton("Full spec")).toHaveAttr("aria-pressed", "false"),
    expect(group).toHaveClass("seg"),
  );
});

it("clicking a segmented option sends it and aria-pressed moves to it", () => {
  scene(
    { update, view },
    start(),
    click(densityButton("Full spec")),
    expect(sent).toHaveText("ClickedDensity full"),
    expect(densityButton("Full spec")).toHaveAttr("aria-pressed", "true"),
    expect(densityButton("Summary")).toHaveAttr("aria-pressed", "false"),
    click(densityButton("Titles")),
    expect(sent).toHaveText("ClickedDensity titles"),
    expect(densityButton("Titles")).toHaveAttr("aria-pressed", "true"),
    expect(densityButton("Full spec")).toHaveAttr("aria-pressed", "false"),
  );
});

it("a closed disclosure has aria-expanded false, no aria-controls and no panel", () => {
  scene(
    { update, view },
    start(),
    expect(specCardHeader).toHaveAttr("aria-expanded", "false"),
    expect(specCardHeader).not.toHaveAttr("aria-controls"),
    expect(specCardPanel).toBeAbsent(),
  );
});

it("opening a disclosure sets aria-expanded and aria-controls and renders its panel", () => {
  scene(
    { update, view },
    start(),
    click(specCardHeader),
    expect(sent).toHaveText("ClickedSpecCard true"),
    expect(specCardHeader).toHaveAttr("aria-expanded", "true"),
    expect(specCardHeader).toHaveAttr("aria-controls", "spec-card-panel"),
    expect(specCardPanel).toContainText("The spec section in full"),
    click(specCardHeader),
    expect(sent).toHaveText("ClickedSpecCard false"),
    expect(specCardHeader).toHaveAttr("aria-expanded", "false"),
    expect(specCardPanel).toBeAbsent(),
  );
});

it("a disclosure also opens on Enter and on Space", () => {
  scene(
    { update, view },
    start(),
    keydown(specCardHeader, "Enter"),
    expect(specCardHeader).toHaveAttr("aria-expanded", "true"),
    keydown(specCardHeader, " "),
    expect(specCardHeader).toHaveAttr("aria-expanded", "false"),
  );
});

// What the controls draw is what the stylesheet selects, and the stylesheet gives it its fill.
it.each([
  ['.btn[aria-checked="true"]'],
  ['.btn[aria-pressed="true"]'],
  ['.seg > button[aria-pressed="true"]'],
])("components.css fills %s with --green", (selectorText) => {
  assert(declarationsOf(selectorText)).toContain("background-color: var(--green)");
});

it.each(SectionStatus.literals)(
  "a dot of status %s carries data-status, which components.css colours as the spec's table says",
  (status) => {
    const tokenOf: Record.ReadonlyRecord<string, string> = {
      blocked_on_human: "--blocked",
      done: "--done",
      failed: "--blocked",
      in_progress: "--progress",
      landed: "--done",
      running: "--progress",
    };
    scene({ update, view }, start(), expect(selector(`.dot[data-status="${status}"]`)).toExist());
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
  },
);

it.each(tagKinds)("a %s tag carries data-kind and its text", (kind) => {
  scene(
    { update, view },
    start(),
    expect(selector(`.tag[data-kind="${kind}"]`)).toHaveText(`a ${kind}`),
  );
});

it("components.css fills a PRD tag and a spec tag, and leaves a task ID and a SHA --raised", () => {
  assert(declarationsOf('.tag[data-kind="prd"]')).toEqual(["background-color: var(--prd)"]);
  assert(declarationsOf('.tag[data-kind="spec"]')).toEqual(["background-color: var(--spec)"]);
  assert(declarationsOf('.tag[data-kind="task"]')).toEqual([]);
  assert(declarationsOf('.tag[data-kind="sha"]')).toEqual([]);
  assert(declarationsOf(".tag")).toContain("background-color: var(--raised)");
});

it("GATE and a label render the classes the stylesheet gives their look", () => {
  scene(
    { update, view },
    start(),
    expect(selector(".gate")).toHaveText("GATE"),
    expect(selector(".label")).toHaveText("Stacks"),
  );
  assert(declarationsOf(".gate")).toContain("color: var(--blocked-ink)");
  assert(declarationsOf(".label")).toContain("text-transform: uppercase");
});
