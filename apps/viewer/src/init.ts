import { Option } from "effect";
import type { Runtime } from "foldkit";

import { ORIGIN_VIEWPORT } from "./canvas.ts";
import type { Message } from "./message.ts";
import { Drawer, PresenceConnection, TraceData, type Model } from "./model.ts";
import { LoadTrace } from "./update.ts";

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  commands: [LoadTrace()],
  model: {
    drawer: Drawer.Closed(),
    isShowingAllCurves: false,
    maybeHovered: Option.none(),
    maybePaneSize: Option.none(),
    maybePanZoomFailure: Option.none(),
    maybeYou: Option.none(),
    participants: [],
    positions: {},
    presenceConnection: PresenceConnection.Connecting(),
    trace: TraceData.Loading(),
    viewport: ORIGIN_VIEWPORT,
  },
});
