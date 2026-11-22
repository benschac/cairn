import { Runtime } from "foldkit";

import { init } from "./init.ts";
import { Model } from "./model.ts";
import { subscriptions } from "./subscription/index.ts";
import { update } from "./update.ts";
import { view } from "./view/view.ts";

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
