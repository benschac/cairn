import { SectionPrefix, TaskId } from "@cairn/contract";
import { Match, Option, Record, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

/** What can be moved on the canvas: a whole document, with its sections, or one task card. */
export const Movable = defineTaggedUnion({
  Document: { document: SectionPrefix },
  Task: { id: TaskId },
});
export type Movable = typeof Movable.Type;

/** A movable's key in `Offsets`, unique across the canvas: "document:prd" or "task:t9". */
export const movableKeyOf = (movable: Movable): string =>
  Movable.match(movable, {
    Document: ({ document }) => `document:${document}`,
    Task: ({ id }) => `task:${id}`,
  });

/** How far a movable sits from where the layout put it, in canvas units. */
export const Offset = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
export type Offset = typeof Offset.Type;

/** Each moved item's offset, by `movableKeyOf`. An item that was never moved has no entry. */
export const Offsets = Schema.Record(Schema.String, Offset);
export type Offsets = typeof Offsets.Type;

/** A pointer's position in window pixels, as a pointer event reports it. */
export const ClientPoint = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
export type ClientPoint = typeof ClientPoint.Type;

/** The id a pointer event gives the pointer, the same on every event of one press. */
export const PointerId = Schema.Int;

/**
 * No drag; a drag of one movable by one pointer, with where that pointer was last seen; or a drag
 * that has just ended. Moves and releases from any other pointer are ignored.
 *
 * `Released` lasts until the click the browser makes of the release, or the next press. That click
 * lands on whatever the pointer was over when it went up, which can be the moved node itself, and
 * it must not count as a click on that node. It keeps the pointer that dragged, so the page
 * listener stays the same listener from the press to that click.
 */
export const DragState = defineTaggedUnion({
  Dragging: { movable: Movable, pointer: ClientPoint, pointerId: PointerId },
  Idle: {},
  Released: { pointerId: PointerId },
});
export type DragState = typeof DragState.Type;

/** The pointer of a drag in progress or just released; none while idle. */
export const gesturePointerOf = (drag: DragState): Option.Option<number> =>
  DragState.match(drag, {
    Dragging: ({ pointerId }) => Option.some(pointerId),
    Idle: () => Option.none(),
    Released: ({ pointerId }) => Option.some(pointerId),
  });

/** A page event the drag listener reacts to, reduced to what decides whether a click is stopped. */
export const GestureEvent = defineTaggedUnion({
  /** A pointer went up; only the drag's own pointer arms the stop. */
  PointerUp: { pointerId: PointerId },
  Clicked: {},
  /** A pointer or a key went down, which starts a new gesture. */
  Pressed: {},
});
export type GestureEvent = typeof GestureEvent.Type;

/**
 * Whether the next click is stopped after one more page event. The drag's pointer going up arms the
 * stop, because the browser clicks wherever that pointer went up, which can be the node that was
 * moved. Another pointer going up does not, so a second finger's tap still reaches its node. A
 * click while armed is stopped and disarms; any press disarms, so a release that makes no click,
 * such as the end of a touch drag, never swallows a later click.
 */
export const gestureStep = (
  dragPointerId: number,
  isArmed: boolean,
  event: GestureEvent,
): Readonly<{ isArmed: boolean; stopsClick: boolean }> =>
  GestureEvent.match(event, {
    Clicked: () => ({ isArmed: false, stopsClick: isArmed }),
    PointerUp: ({ pointerId }) => ({
      isArmed: isArmed || pointerId === dragPointerId,
      stopsClick: false,
    }),
    Pressed: () => ({ isArmed: false, stopsClick: false }),
  });

/** The arrow keys that nudge a movable from its handle. */
export const ArrowKey = Schema.Literals(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"]);
export type ArrowKey = typeof ArrowKey.Type;

/** The arrow key a key name is, if it is one. */
export const arrowKeyOf = (key: string): Option.Option<ArrowKey> =>
  Option.liftPredicate(key, Schema.is(ArrowKey));

/** Canvas units one arrow key press moves a movable. */
export const NUDGE_STEP = 10;

/** The offset one arrow key press adds. */
export const nudgeOf = (key: ArrowKey): Offset =>
  Match.value(key).pipe(
    Match.withReturnType<Offset>(),
    Match.when("ArrowDown", () => ({ x: 0, y: NUDGE_STEP })),
    Match.when("ArrowLeft", () => ({ x: -NUDGE_STEP, y: 0 })),
    Match.when("ArrowRight", () => ({ x: NUDGE_STEP, y: 0 })),
    Match.when("ArrowUp", () => ({ x: 0, y: -NUDGE_STEP })),
    Match.exhaustive,
  );

/**
 * A pointer's move from `from` to `to` in window pixels, as canvas units at `zoom`: the layer is
 * scaled by the zoom, so a pixel on screen is `1 / zoom` canvas units.
 */
export const canvasDeltaOf = (from: ClientPoint, to: ClientPoint, zoom: number): Offset => ({
  x: (to.x - from.x) / zoom,
  y: (to.y - from.y) / zoom,
});

/** A movable's offset; none while it sits where the layout put it. */
export const offsetOf = (offsets: Offsets, movable: Movable): Option.Option<Offset> =>
  Record.get(offsets, movableKeyOf(movable));

/** The offsets with one movable moved by `delta` from wherever it is now. */
export const moveBy =
  (movable: Movable, delta: Offset) =>
  (offsets: Offsets): Offsets => {
    const current = Option.getOrElse(offsetOf(offsets, movable), () => ({ x: 0, y: 0 }));
    return Record.set(offsets, movableKeyOf(movable), {
      x: current.x + delta.x,
      y: current.y + delta.y,
    });
  };

/** The CSS that moves an element by its offset; nothing for an element that was never moved. */
export const offsetStyleOf = (
  offsets: Offsets,
  movable: Movable,
): Record.ReadonlyRecord<string, string> =>
  Option.match(offsetOf(offsets, movable), {
    onNone: () => ({}),
    onSome: ({ x, y }) => ({ transform: `translate(${x}px, ${y}px)` }),
  });

/** The canvas layer carries every offset in this attribute, so the layout mount re-measures after a move. */
export const OFFSETS_ATTRIBUTE = "data-offsets";

/** Encoding offsets to JSON cannot fail: every offset is two finite numbers. */
export const offsetsAttribute = Schema.encodeSync(Schema.fromJsonString(Offsets));
