import { Presence, Sha, Trace } from "@cairn/contract";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { Positions, Size, Viewport } from "./geometry.ts";
import { Node } from "./trace.ts";

export const Message = defineMessageUnion({
  ClickedCommit: { sha: Sha },
  ClickedFit: {},
  ClickedNode: { node: Node },
  ClosedDrawer: {},
  HoveredNode: { node: Node },
  LeftNode: {},
  MeasuredLayout: { positions: Positions },
  /** The canvas mount measured the pane. */
  MeasuredPane: { size: Size },
  /** The canvas mount reports each pan and zoom. */
  PannedOrZoomed: { viewport: Viewport },
  ReceivedPresence: { presence: Presence },
  SettledLoadTrace: { result: Schema.Result(Schema.toType(Trace), Schema.String) },
});
export type Message = typeof Message.Type;
