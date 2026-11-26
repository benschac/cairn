import { Subscription } from "@effect/ui";

import type { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { addressMessages } from "./address.ts";
import { escapeSubscription } from "./escape.ts";
import { presenceSubscription } from "./presence.ts";
import { resizeSubscription } from "./resize.ts";
import { selectionSubscription } from "./selection.ts";
import { traceSubscription } from "./trace.ts";

/** The address: Back, Forward and a fragment followed, and a click on an anchor. */
const addressSubscription = Subscription.make("address", addressMessages);

/** Every stream the viewer listens to, for its Model now. */
export const subscriptions = ({
  model,
}: {
  readonly model: Model;
}): ReadonlyArray<Subscription.Subscription<Message>> => [
  addressSubscription,
  presenceSubscription(model),
  escapeSubscription,
  resizeSubscription(model),
  selectionSubscription,
  traceSubscription,
];
