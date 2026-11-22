import { Mount } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { PanZoomCanvas } from "../src/canvas.ts";
import { demoTrace } from "../src/demo.ts";
import { Message, init } from "../src/main.ts";
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
export const mounted = Mount.resolve(PanZoomCanvas, Message.MeasuredPane({ size: paneSize }));
