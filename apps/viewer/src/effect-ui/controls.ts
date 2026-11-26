import type { Component, View } from "@effect/ui";
import { Collapsible, Switch } from "@effect/ui-kit";
import type { Html } from "@effect/ui/html";

/**
 * `ui/controls.ts`'s switch and disclosure, rebuilt on `@effect/ui-kit`. They draw the same
 * classes, roles, labels and IDs as the Foldkit ones, so the Scene tests that check those keep
 * passing when a view moves. The state stays in the viewer's Model: each takes the current value
 * and builds the Message for the next one. Nothing renders these yet: the views move in
 * `spec.viewer.effect-ui.views`.
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
 * `Switch` drawn as a `btn` with the label inside it. The kit gives the button `type="button"`,
 * `role="switch"` and `aria-checked`, and toggles it on a click; a native button turns Space and
 * Enter into that click, so it needs no key handler. The label carries the ID the button's
 * `aria-labelledby` names, as the Foldkit switch's does.
 */
export const SwitchView = <Msg>(
  h: Html.H<Msg>,
  { id, isChecked, label, onToggle }: SwitchConfig<Msg>,
) =>
  Switch(h, {
    props: { checked: isChecked },
    onToggle: ({ checked }) => onToggle(checked),
    view: (parts) =>
      parts
        .root(h.button.class("btn").attr("aria-labelledby", switchLabelId(id)))
        .children(h.span.id(switchLabelId(id)).children(label)),
  });

/** The header button's ID and the panel's, as `@foldkit/ui`'s `Disclosure` builds them. */
export const disclosureButtonId = (id: string): string => `${id}-button`;
export const disclosurePanelId = (id: string): string => `${id}-panel`;

type CollapsibleParts = Component.Headless.Parts<typeof Collapsible>;

/** What `DisclosureView` gives `view`: the header button and the panel, each applied to a builder. */
export interface DisclosureParts {
  readonly isOpen: boolean;
  /** The consumer's `h.button`, with the header's ID, `aria-expanded` and its click. */
  readonly trigger: CollapsibleParts["trigger"];
  /**
   * The consumer's panel element with the panel's ID, or `undefined` while the disclosure is
   * closed: a closed panel is not rendered, as `ui/controls.ts`'s `toView` leaves it out.
   */
  readonly panel: CollapsibleParts["panel"];
}

export interface DisclosureConfig<Msg, A extends View.Content<Msg, R>, R = never> {
  readonly id: string;
  readonly isOpen: boolean;
  readonly onToggle: (isOpen: boolean) => Msg;
  readonly view: (disclosure: DisclosureParts) => A;
}

/**
 * `Collapsible`, keyed by `id`. The header button has `aria-expanded` and, while open,
 * `aria-controls` naming its panel. The kit's own `Settled` event, sent when a panel's
 * transition ends, means nothing to the viewer and sends no Message.
 */
export const DisclosureView = <Msg, A extends View.Content<Msg, R>, R = never>(
  h: Html.H<Msg>,
  { id, isOpen, onToggle, view }: DisclosureConfig<Msg, A, R>,
) =>
  Collapsible(h, {
    key: id,
    props: { open: isOpen },
    onEmit: {
      Settled: () => undefined,
      Toggled: ({ open }) => onToggle(open),
    },
    view: (collapsible) =>
      view({
        isOpen,
        panel: (element) => collapsible.panel(element.attr("id", disclosurePanelId(id))),
        trigger: (button) => collapsible.trigger(button.attr("id", disclosureButtonId(id))),
      }),
  });
