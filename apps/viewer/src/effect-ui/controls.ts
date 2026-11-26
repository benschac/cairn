import type { Html } from "@effect/ui/html";
import { Array, Equal } from "effect";

import type { Attributable } from "./attributes.ts";

/**
 * The pieces a person works, in Effect UI. They draw the DOM the Foldkit ones drew (the same
 * classes, roles, labels, IDs and keys), so the Scene tests that check it pass unchanged. The state
 * stays in the viewer's Model: each takes the current value and builds the Message for the next
 * one. They are plain native buttons, not `@effect/ui-kit`'s headless `Switch` and
 * `Collapsible`: a Scene does not run a kit child's `update`, so a click on one would not reach the
 * viewer (EFFECT-UI.md, Verdict 3). The kit waits for the components step.
 */

/** The label's ID, as `@foldkit/ui`'s `Switch.labelId` builds it. */
export const switchLabelId = (id: string): string => `${id}-label`;

export interface SwitchConfig<Msg> {
  readonly id: string;
  readonly label: string;
  readonly isChecked: boolean;
  readonly onToggle: (isChecked: boolean) => Msg;
}

/**
 * A switch drawn as a `btn` with its label inside. It has `role="switch"` and `aria-checked`, and
 * toggles on a click and when Space is released. Releasing Space cancels the key's default, so the
 * native button does not click as well. The button names itself by the label inside it, so the
 * label carries only the ID the button points at.
 */
export const switchView = <Msg>(
  h: Html.H<Msg>,
  { id, isChecked, label, onToggle }: SwitchConfig<Msg>,
) =>
  h.button
    .class("btn")
    .attr("type", "button")
    .attr("role", "switch")
    .attr("aria-checked", `${isChecked}`)
    .attr("aria-labelledby", switchLabelId(id))
    .attr("tabindex", "0")
    .attr("data-checked", isChecked ? "" : undefined)
    .on("click", onToggle(!isChecked))
    .on("keyup", ({ key }) => (key === " " ? onToggle(!isChecked) : undefined), {
      preventDefault: true,
    })
    .children(h.span.id(switchLabelId(id)).children(label));

/** The header button's ID and the panel's, as `@foldkit/ui`'s `Disclosure` builds them. */
export const disclosureButtonId = (id: string): string => `${id}-button`;
export const disclosurePanelId = (id: string): string => `${id}-panel`;

/** An `h.button` builder, with whatever the consumer chained on it. */
type ButtonBuilder<Msg> = Html.Element<
  Msg,
  unknown,
  Html.EventsOf<"button">,
  HTMLButtonElement,
  "button"
>;

/** What `disclosureView` gives `view`: functions that put the header's and the panel's attributes on a builder. */
export interface DisclosureParts<Msg> {
  /** The consumer's `h.button`, with the header's ID, `aria-expanded`, its click and its keys. */
  readonly button: <B extends ButtonBuilder<Msg>>(button: B) => B;
  /** The panel's ID. The consumer renders the panel only while the disclosure is open. */
  readonly panel: <B>(panel: B & Attributable<B>) => B;
}

export interface DisclosureConfig<Msg, A> {
  readonly id: string;
  readonly isOpen: boolean;
  readonly onToggle: (isOpen: boolean) => Msg;
  readonly view: (disclosure: DisclosureParts<Msg>) => A;
}

/**
 * A disclosure: a native header button with `aria-expanded` and, while open, `aria-controls`
 * naming its panel and `data-open`. A click toggles it, and so do Enter and Space, which it keeps
 * from the page. `view` lays out the button and the panel; it renders the panel only while
 * `isOpen`, so a closed panel is not in the DOM.
 */
export const disclosureView = <Msg, A>(
  _h: Html.H<Msg>,
  { id, isOpen, onToggle, view }: DisclosureConfig<Msg, A>,
): A =>
  view({
    button: (button) =>
      button
        .attr("id", disclosureButtonId(id))
        .attr("type", "button")
        .attr("aria-expanded", `${isOpen}`)
        .attr("aria-controls", isOpen ? disclosurePanelId(id) : undefined)
        .attr("tabindex", "0")
        .attr("data-open", isOpen ? "" : undefined)
        .on("click", onToggle(!isOpen))
        .on(
          "keydown",
          ({ key }) => (Array.contains(["Enter", " "], key) ? onToggle(!isOpen) : undefined),
          {
            preventDefault: true,
          },
        ),
    panel: (panel) =>
      panel.attrs({ id: disclosurePanelId(id), "data-open": isOpen ? "" : undefined }),
  });

export interface SegmentedOption<Value> {
  readonly value: Value;
  readonly label: string;
}

export interface SegmentedConfig<Value, Msg> {
  readonly label: string;
  readonly options: ReadonlyArray<SegmentedOption<Value>>;
  readonly selected: Value;
  readonly onSelect: (value: Value) => Msg;
}

/**
 * A `seg`: a `role="group"` with that label and one native button for each option, whose
 * `aria-pressed` is true for the selected one.
 */
export const segmentedView = <Value, Msg>(
  h: Html.H<Msg>,
  { label, onSelect, options, selected }: SegmentedConfig<Value, Msg>,
) =>
  h.div
    .class("seg")
    .attr("role", "group")
    .attr("aria-label", label)
    .children(
      Array.map(options, (option) =>
        h.button
          .attr("type", "button")
          .attr("aria-pressed", `${Equal.equals(option.value, selected)}`)
          .on("click", onSelect(option.value))
          .children(option.label),
      ),
    );
