import { Runtime } from "foldkit";

// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet is imported for its effect on the page
import "./ui/tokens.css";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet is imported for its effect on the page
import "./ui/base.css";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet is imported for its effect on the page
import "./ui/components.css";

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
