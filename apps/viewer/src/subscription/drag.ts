import { Effect, MutableRef, Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { GestureEvent, gesturePointerOf, gestureStep, type ClientPoint } from "../drag.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";

const pointerOf = (event: PointerEvent): ClientPoint => ({ x: event.clientX, y: event.clientY });

const onDocument = <A extends Event>(name: string, isCapture = false) =>
  Stream.fromEventListener<A>(document, name, { capture: isCapture });

/**
 * The page's pointer moves and releases during the drag by `dragPointerId`, and the end of the
 * gesture. Whether the click after a release is stopped is decided by `gestureStep`: only the
 * drag's own pointer going up arms the stop, and the next press disarms it.
 */
const dragGestureMessages = (dragPointerId: number) => {
  const isArmed = MutableRef.make(false);
  const step = (event: GestureEvent): boolean => {
    const next = gestureStep(dragPointerId, MutableRef.get(isArmed), event);
    MutableRef.set(isArmed, next.isArmed);
    return next.stopsClick;
  };
  const moves: Stream.Stream<Message> = Stream.map(
    onDocument<PointerEvent>("pointermove"),
    (event) =>
      Message.MovedDragPointer({
        buttons: event.buttons,
        pointer: pointerOf(event),
        pointerId: event.pointerId,
      }),
  );
  const releases = Stream.map(
    Stream.merge(
      Stream.tap(onDocument<PointerEvent>("pointerup"), (event) =>
        Effect.sync(() => step(GestureEvent.PointerUp({ pointerId: event.pointerId }))),
      ),
      onDocument<PointerEvent>("pointercancel"),
    ),
    (event) => Message.ReleasedDragPointer({ pointerId: event.pointerId }),
  );
  const clicks = onDocument<MouseEvent>("click", true).pipe(
    Stream.filter((event) => {
      const stops = step(GestureEvent.Clicked());
      if (stops) {
        event.stopPropagation();
      }
      return stops;
    }),
    Stream.map(() => Message.SuppressedClickAfterDrag()),
  );
  const pointerPresses = Stream.map(
    Stream.tap(onDocument<PointerEvent>("pointerdown", true), () =>
      Effect.sync(() => step(GestureEvent.Pressed())),
    ),
    (event) => Message.PressedAfterDrag({ isPrimaryPointer: event.isPrimary }),
  );
  const keyPresses = Stream.map(
    Stream.tap(onDocument<KeyboardEvent>("keydown", true), () =>
      Effect.sync(() => step(GestureEvent.Pressed())),
    ),
    () => Message.PressedAfterDrag({ isPrimaryPointer: false }),
  );
  return Stream.mergeAll([moves, releases, clicks, pointerPresses, keyPresses], {
    concurrency: "unbounded",
  });
};

/**
 * The page's pointer events, only from the moment a drag starts until the click its release makes
 * or the next press. The page listens rather than the handle, so a drag keeps going when the
 * pointer outruns the handle it pressed. The dependency is the drag's pointer, which a drag keeps
 * from its press to its release, so the listener and whether it is armed survive the release.
 */
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  dragGesture: entry(
    { maybeDragPointerId: Schema.Option(Schema.Int) },
    {
      modelToDependencies: (model) => ({ maybeDragPointerId: gesturePointerOf(model.drag) }),
      dependenciesToStream: ({ maybeDragPointerId }) =>
        Option.match(maybeDragPointerId, {
          onNone: () => Stream.empty,
          onSome: (dragPointerId) => Stream.suspend(() => dragGestureMessages(dragPointerId)),
        }),
    },
  ),
}));
