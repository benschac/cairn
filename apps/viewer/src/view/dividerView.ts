import { Match, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../message.ts";
import { dividerKeyOf, limitsOf, type Pane, type Widths } from "../panes.ts";

/** The main mouse button, and the button a touch or a pen contact reports. */
const PRIMARY_BUTTON = 0;

/** Wide enough for the curves to pass over: the two between the panes are 76px each. */
export const DIVIDER_WIDTH = 76;

const labelOf = (pane: Pane): string =>
  Match.value(pane).pipe(
    Match.when("prd", () => "Resize the PRD pane"),
    Match.when("spec", () => "Resize the spec pane"),
    Match.when("detail", () => "Resize the detail panel"),
    Match.exhaustive,
  );

/** What a pointer press on a divider says: a resize starts with the primary button, and no other. */
export const pressOnDivider =
  (pane: Pane) =>
  (
    _pointerType: string,
    button: number,
    _screenX: number,
    _screenY: number,
    _timeStamp: number,
    clientX: number,
    _clientY: number,
    pointerId: number,
  ): Option.Option<Message> =>
    button === PRIMARY_BUTTON
      ? Option.some(Message.PressedDivider({ pane, pointerId, x: clientX }))
      : Option.none();

/**
 * The handle between two panes, or on the detail panel's left edge. It is a vertical separator that
 * can be focused: the arrow keys move it, and a press and drag with a pointer does too. The line is
 * drawn in the middle of its wide, empty strip.
 */
export const dividerView = (pane: Pane, widths: Widths, h: HtmlBuilder<Message>): Html => {
  const { max, min } = limitsOf(pane);
  return h.div([
    h.Role("separator"),
    h.AriaOrientation("vertical"),
    h.AriaLabel(labelOf(pane)),
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
      background: "linear-gradient(var(--hair), var(--hair)) center / var(--line) 100% no-repeat",
      cursor: "col-resize",
      "touch-action": "none",
      "user-select": "none",
      width: `${DIVIDER_WIDTH}px`,
    }),
  ]);
};
