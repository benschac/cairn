import { Runtime } from "foldkit";

import { init } from "./init.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { subscriptions } from "./subscription/index.ts";
import { update } from "./update.ts";
import { view } from "./view/view.ts";

Runtime.run(
  Runtime.makeApplication({
    Model,
    container: document.getElementById("root"),
    devTools: { Message },
    init,
    subscriptions,
    update,
    view,
  }),
);
