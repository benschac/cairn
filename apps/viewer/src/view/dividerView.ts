import { Mount as UiMount } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Filter, Match, Option, Predicate, Schema, Stream } from "effect";

import { styleText } from "../effect-ui/attributes.ts";
import type { HostMount } from "../effect-ui/bridge.ts";
import { Message } from "../message.ts";
import { Pane, dividerKeyOf, limitsOf, type Widths } from "../panes.ts";

/** The main mouse button, and the button a touch or a pen contact reports. */
const PRIMARY_BUTTON = 0;

/** Wide enough for the curves to pass over: the two between the panes are 76px each. */
export const DIVIDER_WIDTH = 76;

/**
 * The detail panel's handle: no curve passes over it, and half of it lies inside the panel, so it
 * is narrower than the panel's padding and no control sits under it.
 */
export const DETAIL_HANDLE_WIDTH = 16;

/** The handle on the stacks pane's right edge: no curve passes over it either. */
export const STACKS_HANDLE_WIDTH = 16;

/** How wide a pane's divider is. */
export const handleWidthOf = (pane: Pane): number =>
  Match.value(pane).pipe(
    Match.when("detail", () => DETAIL_HANDLE_WIDTH),
    Match.when("stacks", () => STACKS_HANDLE_WIDTH),
    Match.orElse(() => DIVIDER_WIDTH),
  );

/** What a divider's separator is named, for the pane it resizes. */
export const dividerLabelOf = (pane: Pane): string =>
  Match.value(pane).pipe(
    Match.when("prd", () => "Resize the PRD pane"),
    Match.when("spec", () => "Resize the spec pane"),
    Match.when("stacks", () => "Resize the stacks pane"),
    Match.when("detail", () => "Resize the detail panel"),
    Match.exhaustive,
  );

/** Something with a rendered box, as an element is. */
interface Boxed {
  readonly getBoundingClientRect: () => { readonly width: number };
}

const isBoxed = (u: unknown): u is Boxed =>
  Predicate.hasProperty(u, "getBoundingClientRect") &&
  Predicate.isFunction(u.getBoundingClientRect);

const hasClosest = (u: unknown): u is { readonly closest: (selector: string) => unknown } =>
  Predicate.hasProperty(u, "closest") && Predicate.isFunction(u.closest);

const hasPreviousSibling = (u: unknown): u is { readonly previousElementSibling: unknown } =>
  Predicate.hasProperty(u, "previousElementSibling");

const paneOf = (pane: Pane, target: unknown): Option.Option<unknown> =>
  pane === "detail"
    ? Option.map(Option.liftPredicate(target, hasClosest), (t) => t.closest("[data-detail]"))
    : Option.map(Option.liftPredicate(target, hasPreviousSibling), (t) => t.previousElementSibling);

/**
 * The width a pane is rendered at, read from the divider that was pressed: the PRD's, the spec's and
 * the stacks' dividers follow their pane in the grid, and the detail panel's sits inside it (`[data-detail]`). It differs from the
 * chosen width when the grid's `minmax` holds the pane narrower. None when the target is no element
 * with a pane beside it.
 */
export const renderedWidthOf = (pane: Pane, target: unknown): Option.Option<number> =>
  Option.map(
    Option.filter(paneOf(pane, target), isBoxed),
    (paneElement) => paneElement.getBoundingClientRect().width,
  );

/**
 * What a pointer press on a divider says: a resize starts with the primary button, and no other.
 * It carries the pane's rendered width, so the drag starts from what the person sees.
 */
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
    target: EventTarget | null,
  ): Option.Option<Message> =>
    button === PRIMARY_BUTTON
      ? Option.some(
          Message.PressedDivider({
            maybeWidth: renderedWidthOf(pane, target),
            pane,
            pointerId,
            x: clientX,
          }),
        )
      : Option.none();

/**
 * A press on a divider under Effect UI. Its handlers get a payload with no `pointerId` and no
 * target element, and the resize follows one pointer from the pane it reads, so the press is a
 * mount that listens on the divider itself.
 */
export const PressDivider = UiMount.makeStream(
  "PressDivider",
  { args: { pane: Pane } },
  (node: HTMLElement, { pane }) =>
    Stream.fromEventListener<PointerEvent>(node, "pointerdown").pipe(
      Stream.filterMap(
        Filter.fromPredicateOption((event) =>
          pressOnDivider(pane)(
            event.pointerType,
            event.button,
            event.screenX,
            event.screenY,
            event.timeStamp,
            event.clientX,
            event.clientY,
            event.pointerId,
            event.target,
          ),
        ),
      ),
    ),
);

const decodePane = Schema.decodeUnknownSync(Pane);

/**
 * The bridge puts `PressDivider` on each divider still drawn by Foldkit (`foldkit/dividerView.ts`,
 * in the detail panel), which `data-divider` names, in place of its Foldkit `pointerdown` handler.
 */
export const dividerHostMount: HostMount<Message> = {
  attribute: "data-divider",
  events: ["pointerdown"],
  mount: (pane) => PressDivider({ pane: decodePane(pane) }),
};

/**
 * The handle between two panes, or on the detail panel's left edge. It is a vertical separator that
 * can be focused: the arrow keys move it, and a press and drag with a pointer does too, through the
 * `PressDivider` mount, since a handler's payload has no `pointerId`. The line is drawn in the
 * middle of its wide, empty strip.
 */
export const dividerView = (h: Html.H<Message>, pane: Pane, widths: Widths) => {
  const { max, min } = limitsOf(pane);
  return h.div
    .class("divider")
    .attr("role", "separator")
    .attr("aria-orientation", "vertical")
    .attr("aria-label", dividerLabelOf(pane))
    .attr("aria-valuenow", `${widths[pane]}`)
    .attr("aria-valuemin", `${min}`)
    .attr("aria-valuemax", `${max}`)
    .attr("tabindex", "0")
    .attr("data-divider", pane)
    .attr("style", styleText({ "user-select": "none", width: `${handleWidthOf(pane)}px` }))
    .on(
      "keydown",
      ({ key }) =>
        Option.getOrUndefined(
          Option.map(dividerKeyOf(key), (arrow) =>
            Message.PressedArrowOnDivider({ key: arrow, pane }),
          ),
        ),
      { preventDefault: true },
    )
    .onMount(PressDivider({ pane }));
};
