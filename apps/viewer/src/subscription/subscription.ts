import { Subscription } from "foldkit";

import { subscriptions as dragSubscriptions } from "./drag.ts";
import { subscriptions as presenceSubscriptions } from "./presence.ts";

export const subscriptions = Subscription.aggregate(presenceSubscriptions, dragSubscriptions);
