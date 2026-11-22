import { Option } from "effect";
import type { Runtime } from "foldkit";

import { originViewport } from "./canvas.ts";
import type { Message } from "./message.ts";
import { TraceData, type Model } from "./model.ts";
import { LoadTrace } from "./update.ts";

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  commands: [LoadTrace()],
  model: {
    maybeCommit: Option.none(),
    maybeDrawer: Option.none(),
    maybeHovered: Option.none(),
    maybePane: Option.none(),
    maybeSelected: Option.none(),
    participants: [],
    positions: {},
    trace: TraceData.Loading(),
    viewport: originViewport,
    you: Option.none(),
  },
});
