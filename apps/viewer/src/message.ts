import { Presence, Sha, TaskId, Trace } from "@cairn/contract";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { Positions, Size, Viewport } from "./geometry.ts";
import { Node } from "./trace.ts";

export const Message = defineMessageUnion({
  /** The drawer's Close button. */
  ClickedCloseDrawer: {},
  ClickedCommit: { sha: Sha },
  /** A task listed in a section's drawer. */
  ClickedDrawerTask: { id: TaskId },
  ClickedFit: {},
  ClickedNode: { node: Node },
  /** The presence socket closed or failed. */
  ClosedPresence: {},
  CompletedFocusDrawerHeading: {},
  CompletedFocusNode: {},
  /** The canvas mount could not start pan and zoom. */
  FailedPanZoomCanvas: { reason: Schema.String },
  HoveredNode: { node: Node },
  LeftNode: {},
  MeasuredLayout: { positions: Positions },
  /** The canvas mount measured the pane. */
  MeasuredPane: { size: Size },
  /** The presence socket opened. */
  OpenedPresence: {},
  /** The canvas mount reports each pan and zoom. */
  PannedOrZoomed: { viewport: Viewport },
  ReceivedPresence: { presence: Presence },
  SettledLoadTrace: { result: Schema.Result(Schema.toType(Trace), Schema.String) },
});
export type Message = typeof Message.Type;
