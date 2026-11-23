import { Option } from "effect";
import type { Runtime } from "foldkit";

import { ORIGIN_VIEWPORT } from "./canvas.ts";
import { DragState } from "./drag.ts";
import type { Message } from "./message.ts";
import { Drawer, PresenceConnection, TraceData, type Model } from "./model.ts";
import { EMPTY_SEARCH } from "./search.ts";
import { LoadTrace } from "./update.ts";

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  commands: [LoadTrace()],
  model: {
    drag: DragState.Idle(),
    drawer: Drawer.Closed(),
    isShowingAllCurves: false,
    maybeCentring: Option.none(),
    maybeHovered: Option.none(),
    maybePaneSize: Option.none(),
    maybePanZoomFailure: Option.none(),
    maybeYou: Option.none(),
    offsets: {},
    participants: [],
    pins: [],
    positions: {},
    presenceConnection: PresenceConnection.Connecting(),
    search: EMPTY_SEARCH,
    trace: TraceData.Loading(),
    viewport: ORIGIN_VIEWPORT,
  },
});
