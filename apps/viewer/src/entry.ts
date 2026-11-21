import { Runtime } from "foldkit";

import { init, update, view } from "./main.ts";
import { Model } from "./model.ts";

Runtime.run(
  Runtime.makeApplication({
    Model,
    container: document.getElementById("root"),
    init,
    update,
    view,
  }),
);
