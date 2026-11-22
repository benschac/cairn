import { Option } from "effect";
import type { Runtime } from "foldkit";

import { ORIGIN_VIEWPORT } from "./canvas.ts";
import type { Message } from "./message.ts";
import { TraceData, type Model } from "./model.ts";
import { LoadTrace } from "./update.ts";

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  commands: [LoadTrace()],
  model: {
    maybeDrawer: Option.none(),
    maybeHovered: Option.none(),
    maybePaneSize: Option.none(),
    maybeSelected: Option.none(),
    maybeSelectedCommitSha: Option.none(),
    maybeYou: Option.none(),
    participants: [],
    positions: {},
    trace: TraceData.Loading(),
    viewport: ORIGIN_VIEWPORT,
  },
});
