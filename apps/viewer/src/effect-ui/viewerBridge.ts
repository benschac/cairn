import { DrawDiagram } from "../diagram.ts";
import { Message } from "../message.ts";
import { makeFoldkitBridge } from "./bridge.ts";

/**
 * The bridge the viewer's Foldkit views render through: every Foldkit Mount they issue. An Effect UI view renders a view that has not
 * moved with `viewerBridge.bridged(h, (foldkit) => someView(..., foldkit))`, inside the pass
 * `Viewer`'s `view` opens with `viewerBridge.render`. A Mount leaves the list when the view that
 * issues it moves and issues an Effect UI mount of the same name instead.
 */
export const viewerBridge = makeFoldkitBridge({
  message: Message,
  mounts: [DrawDiagram],
});
