// The Foldkit copy of a view that has moved to Effect UI, for the views still on Foldkit, which
// render under the bridge (`spec.viewer.effect-ui.views`). Delete it in the change that moves its
// last importer: `rg -l "foldkit/<this file>" apps/viewer/src`.

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../message.ts";
import { dividerKeyOf, limitsOf, type Pane, type Widths } from "../panes.ts";
import { dividerLabelOf, handleWidthOf, pressOnDivider } from "../view/dividerView.ts";

/**
 * The handle between two panes, or on the detail panel's left edge. It is a vertical separator that
 * can be focused: the arrow keys move it, and a press and drag with a pointer does too. The line is
 * drawn in the middle of its wide, empty strip. Under the bridge, `data-divider` gives it the
 * `PressDivider` mount in place of its `pointerdown` handler (`dividerHostMount`).
 */
export const dividerView = (pane: Pane, widths: Widths, h: HtmlBuilder<Message>): Html => {
  const { max, min } = limitsOf(pane);
  return h.div([
    h.Class("divider"),
    h.Role("separator"),
    h.AriaOrientation("vertical"),
    h.AriaLabel(dividerLabelOf(pane)),
    h.AriaValuenow(widths[pane]),
    h.AriaValuemin(min),
    h.AriaValuemax(max),
    h.Tabindex(0),
    h.DataAttribute("divider", pane),
    h.OnPointerDown(pressOnDivider(pane)),
    h.OnKeyDownPreventDefault((key) =>
      Option.map(dividerKeyOf(key), (arrow) => Message.PressedArrowOnDivider({ key: arrow, pane })),
    ),
    h.Style({
      "user-select": "none",
      width: `${handleWidthOf(pane)}px`,
    }),
  ]);
};
