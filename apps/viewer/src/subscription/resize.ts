import { Option, Schema, Stream } from "effect";
import { Subscription } from "foldkit";

import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { resizePointerOf } from "../panes.ts";

const onDocument = <A extends Event>(name: string) => Stream.fromEventListener<A>(document, name);

/** The page's pointer moves and releases, so a resize keeps going when the pointer outruns the divider. */
const resizeMessages = Stream.merge(
  Stream.map(onDocument<PointerEvent>("pointermove"), (event) =>
    Message.MovedResizePointer({
      buttons: event.buttons,
      pointerId: event.pointerId,
      x: event.clientX,
    }),
  ),
  Stream.map(
    Stream.merge(onDocument<PointerEvent>("pointerup"), onDocument<PointerEvent>("pointercancel")),
    (event) => Message.ReleasedResizePointer({ pointerId: event.pointerId }),
  ),
);

/** The page's pointer events, only from a divider's press until its release. */
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  resizeGesture: entry(
    { maybeResizePointerId: Schema.Option(Schema.Int) },
    {
      modelToDependencies: (model) => ({ maybeResizePointerId: resizePointerOf(model.resize) }),
      dependenciesToStream: ({ maybeResizePointerId }) =>
        Option.match(maybeResizePointerId, {
          onNone: () => Stream.empty,
          onSome: () => Stream.suspend(() => resizeMessages),
        }),
    },
  ),
}));
