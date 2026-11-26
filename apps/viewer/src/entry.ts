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
import { update, withAddress } from "./update.ts";
import { view } from "./view/view.ts";

Runtime.run(
  Runtime.makeApplication({
    Model,
    container: document.getElementById("root"),
    devTools: { Message },
    init,
    // The viewer owns the address: Back, Forward and a hash change arrive as ChangedUrl, and a
    // click on an anchor goes where the browser would take it.
    routing: {
      onUrlChange: (url) => Message.ChangedUrl({ url }),
      onUrlRequest: (request) => Message.ClickedLink({ request }),
    },
    subscriptions,
    update: withAddress(update),
    view,
  }),
);
