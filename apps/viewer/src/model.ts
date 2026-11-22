import { Participant, ParticipantId, Sha, Trace } from "@cairn/contract";
import { Schema } from "effect";
import { AsyncData } from "foldkit";

import { Size, Viewport } from "./canvas.ts";
import { Positions } from "./curves.ts";
import { Node } from "./trace.ts";

/** The trace as it loads: nothing yet, a failure, the trace, or the last good trace beside a failure. */
export const TraceData = AsyncData.Schema(Schema.toType(Trace), Schema.String);
export type TraceData = typeof TraceData.schema.Type;

export const Model = Schema.Struct({
  /** The commit clicked in the open drawer. */
  maybeCommit: Schema.Option(Sha),
  /** The node the detail drawer is open on. */
  maybeDrawer: Schema.Option(Node),
  maybeHovered: Schema.Option(Node),
  /** The canvas pane's size, once its mount has measured it. */
  maybePane: Schema.Option(Size),
  maybeSelected: Schema.Option(Node),
  participants: Schema.Array(Participant),
  positions: Positions,
  trace: TraceData.schema,
  /** Where the canvas layer sits in its pane. */
  viewport: Viewport,
  you: Schema.Option(ParticipantId),
});
export type Model = typeof Model.Type;
