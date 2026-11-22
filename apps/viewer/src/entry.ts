import { Runtime, Subscription } from "foldkit";

import { subscriptions as layoutSubscriptions } from "./layout.ts";
import { init, update, view } from "./main.ts";
import { Model } from "./model.ts";
import { subscriptions as presenceSubscriptions } from "./presence.ts";

const subscriptions = Subscription.aggregate(presenceSubscriptions, layoutSubscriptions);

Runtime.run(
  Runtime.makeApplication({
    Model,
    container: document.getElementById("root"),
    init,
    subscriptions,
    update,
    view,
  }),
);
