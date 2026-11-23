import { Array, Option, Record } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { arrowKeyOf, movableKeyOf, type Movable } from "../drag.ts";
import { Message } from "../message.ts";

// NOTE: a native button with Type("button"). @foldkit/ui's Button.view adds only Tabindex(0)
// over that, so it is not a dependency.

/** The main mouse button, and the button a touch or a pen contact reports. */
const PRIMARY_BUTTON = 0;

const GRIP = "⠿";

/** What a pointer press on a grip says: a drag starts with the primary button, and no other. */
export const pressOnGrip =
  (movable: Movable) =>
  (
    _pointerType: string,
    button: number,
    _screenX: number,
    _screenY: number,
    _timeStamp: number,
    clientX: number,
    clientY: number,
    pointerId: number,
  ): Option.Option<Message> =>
    button === PRIMARY_BUTTON
      ? Option.some(
          Message.PressedMoveHandle({ movable, pointer: { x: clientX, y: clientY }, pointerId }),
        )
      : Option.none();

/**
 * What every handle carries: its label, the press that starts a drag, the click that stops at the
 * handle and never toggles the node under it, and the arrow keys that nudge its item.
 */
const handleAttributes = (movable: Movable, label: string, h: HtmlBuilder<Message>) => [
  h.Type("button"),
  // `nopan`: a drag that starts on the handle moves its item instead of panning the canvas.
  h.Class("nopan"),
  h.AriaLabel(label),
  h.Title("Drag to move, or use the arrow keys"),
  h.DataAttribute("move-handle", movableKeyOf(movable)),
  h.OnPointerDown(pressOnGrip(movable)),
  // A click on the handle, from the keyboard or from a press that did not move, ends here and
  // never toggles the node the handle sits on.
  h.OnClick(Message.ClickedMoveHandle(), { propagation: "Stop" }),
  h.OnKeyDownPreventDefault((key) =>
    Option.map(arrowKeyOf(key), (arrow) =>
      Message.PressedArrowOnMoveHandle({ key: arrow, movable }),
    ),
  ),
];

/** What a handle looks like while it can be grabbed. */
const GRAB_STYLE = {
  cursor: "grab",
  // A touch on the handle drags the item; it does not scroll or zoom the page.
  "touch-action": "none",
  "user-select": "none",
};

/**
 * The grip a task card is dragged by. Only the grip starts a drag, so a drag anywhere else on the
 * card still selects its text. With the grip focused, the arrow keys nudge the card.
 */
export const moveHandleView = (movable: Movable, label: string, h: HtmlBuilder<Message>): Html =>
  h.button(
    Array.append(
      handleAttributes(movable, label, h),
      h.Style(
        Record.union(
          GRAB_STYLE,
          {
            background: "none",
            border: "1px solid #cbd5e1",
            "border-radius": "4px",
            color: "#64748b",
            "font-size": "12px",
            "line-height": "1",
            padding: "2px 4px",
          },
          (_grab, own) => own,
        ),
      ),
    ),
    [GRIP],
  );

/**
 * The bar across the top of a document that drags the whole document: press anywhere on it and
 * move. It names the document and its file, so it reads as the document's title bar.
 */
export const moveBarView = (
  movable: Movable,
  label: string,
  text: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    Array.append(
      handleAttributes(movable, label, h),
      h.Style(
        Record.union(
          GRAB_STYLE,
          {
            background: "#f1f5f9",
            border: "1px solid #cbd5e1",
            "border-radius": "6px",
            color: "#475569",
            display: "block",
            font: "12px system-ui, sans-serif",
            "margin-bottom": "12px",
            padding: "6px 10px",
            "text-align": "left",
            width: "100%",
          },
          (_grab, own) => own,
        ),
      ),
    ),
    [`${GRIP} ${text}`],
  );
