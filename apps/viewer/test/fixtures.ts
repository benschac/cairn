import { Mount } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { PanZoomCanvas } from "../src/canvas.ts";
import { demoTrace } from "../src/demo.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/message.ts";
import { TraceData } from "../src/model.ts";

/** A fresh model holding the demo trace. */
export const loaded = modifyFields(init().model, {
  trace: () => TraceData.Success({ data: demoTrace }),
});

/** The size a scene gives the canvas pane. */
export const paneSize = { height: 600, width: 1200 };

/**
 * Scene tests run no hooks, so the canvas pane's mount stays pending until the test answers for
 * it with the message the library would send first.
 */
// oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
export const mounted = Mount.resolve(PanZoomCanvas, Message.MeasuredPane({ size: paneSize }));
