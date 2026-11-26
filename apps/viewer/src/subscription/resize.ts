import { Subscription } from "@effect/ui";
import { Option, Predicate, Stream } from "effect";

import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { resizePointerOf } from "../panes.ts";
import { inPage } from "./page.ts";

const onDocument = <A extends Event>(name: string) => Stream.fromEventListener<A>(document, name);

/** The page's pointer moves and releases, so a resize keeps going when the pointer outruns the divider. */
const resizeMessages = Stream.suspend(() =>
  Stream.merge(
    Stream.map(onDocument<PointerEvent>("pointermove"), (event) =>
      Message.MovedResizePointer({
        buttons: event.buttons,
        pointerId: event.pointerId,
        x: event.clientX,
      }),
    ),
    Stream.map(
      Stream.merge(
        onDocument<PointerEvent>("pointerup"),
        onDocument<PointerEvent>("pointercancel"),
      ),
      (event) => Message.ReleasedResizePointer({ pointerId: event.pointerId }),
    ),
  ),
);

/**
 * The page's pointer events, only from a divider's press until its release. The pointer is the
 * key, so a press with another pointer starts the stream again.
 */
export const resizeSubscription = (model: Model) =>
  Subscription.make("resizeGesture", Option.getOrNull(resizePointerOf(model.resize)), (pointerId) =>
    Predicate.isNull(pointerId) ? Stream.empty : inPage(resizeMessages),
  );
