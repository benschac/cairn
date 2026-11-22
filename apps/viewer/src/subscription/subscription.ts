import { Subscription } from "foldkit";

import { subscriptions as layoutSubscriptions } from "./layout.ts";
import { subscriptions as presenceSubscriptions } from "./presence.ts";

export const subscriptions = Subscription.aggregate(presenceSubscriptions, layoutSubscriptions);
