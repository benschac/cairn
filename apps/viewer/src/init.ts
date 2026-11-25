import { Option } from "effect";
import type { Runtime } from "foldkit";

import { ORIGIN_VIEWPORT } from "./canvas.ts";
import { DragState } from "./drag.ts";
import type { Message } from "./message.ts";
import { Drawer, PresenceConnection, Screen, TraceData, type Model } from "./model.ts";
import { INITIAL_WIDTHS, Resize } from "./panes.ts";
import { NO_SEARCH } from "./search.ts";
import { LoadTrace } from "./update.ts";

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  commands: [LoadTrace()],
  model: {
    diffStyle: "unified",
    detail: [],
    drag: DragState.Idle(),
    drawer: Drawer.Closed(),
    isShowingAllCurves: false,
    isShowingModels: true,
    maybeCopied: Option.none(),
    maybeHovered: Option.none(),
    maybeMeasuredWires: Option.none(),
    maybePaneSize: Option.none(),
    maybePanZoomFailure: Option.none(),
    maybeYou: Option.none(),
    offsets: {},
    participants: [],
    readers: [],
    patches: {},
    pins: [],
    positions: {},
    presenceConnection: PresenceConnection.Connecting(),
    reader: {
      density: "summary",
      isPrdCondensed: false,
      maybeAtTop: Option.none(),
      maybePinned: Option.none(),
      opened: {},
      prdOpened: {},
    },
    resize: Resize.Idle(),
    search: NO_SEARCH,
    screen: Screen.Canvas(),
    trace: TraceData.Loading(),
    viewport: ORIGIN_VIEWPORT,
    widths: INITIAL_WIDTHS,
    hasChosenStacksWidth: false,
  },
});
