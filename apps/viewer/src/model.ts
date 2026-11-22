import { Participant, ParticipantId, Sha, Trace } from "@cairn/contract";
import { Schema } from "effect";
import { AsyncData } from "foldkit";

import { Positions, Size, Viewport } from "./geometry.ts";
import { Node } from "./trace.ts";

/** The trace as it loads: nothing yet, a failure, the trace, or the last good trace beside a failure. */
export const TraceData = AsyncData.Schema(Schema.toType(Trace), Schema.String);
export type TraceData = typeof TraceData.schema.Type;

export const Model = Schema.Struct({
  /** The node the detail drawer is open on. */
  maybeDrawer: Schema.Option(Node),
  maybeHovered: Schema.Option(Node),
  /** The canvas pane's size, once its mount has measured it. */
  maybePaneSize: Schema.Option(Size),
  maybeSelected: Schema.Option(Node),
  /** The commit clicked in the open drawer. */
  maybeSelectedCommitSha: Schema.Option(Sha),
  maybeYou: Schema.Option(ParticipantId),
  participants: Schema.Array(Participant),
  positions: Positions,
  trace: TraceData.schema,
  /** Where the canvas layer sits in its pane. */
  viewport: Viewport,
});
export type Model = typeof Model.Type;
