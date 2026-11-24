import { Disclosure, Switch } from "@foldkit/ui";
import { Array, Equal } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

/**
 * The pieces a person works. The state stays in the viewer's Model: each takes the current value
 * and builds the Message for the next one.
 */

export interface SwitchConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly isChecked: boolean;
  readonly onToggle: (isChecked: boolean) => Message;
}

/**
 * `Switch.view` drawn as a `btn` with a small box that is ticked when on. It has
 * `role="switch"` and `aria-checked`, and toggles on a click and on Space. The button names
 * itself by the label inside it, so the label carries only the ID the button points at.
 */
export const switchView = <Message>(
  { id, isChecked, label, onToggle }: SwitchConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  Switch.view(
    {
      id,
      isChecked,
      onToggle,
      toView: ({ button }) =>
        h.button(Array.prepend(button, h.Class("btn")), [
          h.span([h.Id(Switch.labelId(id))], [label]),
        ]),
    },
    h,
  );

/** What `disclosureView` gives `toView`: the header button's attributes and the panel's. */
export interface DisclosureAttributes<Message> {
  readonly button: ReadonlyArray<Attribute<Message>>;
  readonly panel: ReadonlyArray<Attribute<Message>>;
}

export interface DisclosureConfig<Message> {
  readonly id: string;
  readonly isOpen: boolean;
  readonly onToggle: (isOpen: boolean) => Message;
  readonly toView: (attributes: DisclosureAttributes<Message>) => Html;
}

/**
 * `Disclosure.view`. The header button has `aria-expanded` and, while open, `aria-controls`
 * naming its panel. `toView` renders the panel only while `isOpen`, so `animatePanel`, which keeps
 * the panel mounted, is not offered.
 */
export const disclosureView = <Message>(
  { id, isOpen, onToggle, toView }: DisclosureConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  Disclosure.view(
    { id, isOpen, onToggle, toView: ({ button, panel }) => toView({ button, panel }) },
    h,
  );

export interface SegmentedOption<Value> {
  readonly value: Value;
  readonly label: string;
}

export interface SegmentedConfig<Value, Message> {
  readonly label: string;
  readonly options: ReadonlyArray<SegmentedOption<Value>>;
  readonly selected: Value;
  readonly onSelect: (value: Value) => Message;
}

/**
 * A `seg`: a `role="group"` with that label and one native button for each option, whose
 * `aria-pressed` is true for the selected one. It does not use `RadioGroup`, which keeps a Model
 * of its own for what is one field of the viewer's.
 */
export const segmentedView = <Value, Message>(
  { label, onSelect, options, selected }: SegmentedConfig<Value, Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class("seg"), h.Role("group"), h.AriaLabel(label)],
    Array.map(options, (option) =>
      h.button(
        [
          h.Type("button"),
          h.AriaPressed(`${Equal.equals(option.value, selected)}`),
          h.OnClick(onSelect(option.value)),
        ],
        [option.label],
      ),
    ),
  );
