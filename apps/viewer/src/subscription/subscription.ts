import { Subscription } from "foldkit";

import { subscriptions as escapeSubscriptions } from "./escape.ts";
import { subscriptions as presenceSubscriptions } from "./presence.ts";
import { subscriptions as resizeSubscriptions } from "./resize.ts";
import { subscriptions as selectionSubscriptions } from "./selection.ts";
import { subscriptions as traceSubscriptions } from "./trace.ts";

export const subscriptions = Subscription.aggregate(
  presenceSubscriptions,
  escapeSubscriptions,
  resizeSubscriptions,
  selectionSubscriptions,
  traceSubscriptions,
);
