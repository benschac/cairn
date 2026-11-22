import { Participant, ParticipantId, Trace } from "@cairn/contract";
import { Schema } from "effect";
import { AsyncData } from "foldkit";

import { Positions } from "./curves.ts";
import { Node } from "./trace.ts";

/** The trace as it loads: nothing yet, a failure, the trace, or the last good trace beside a failure. */
export const TraceData = AsyncData.Schema(Schema.toType(Trace), Schema.String);
export type TraceData = typeof TraceData.schema.Type;

export const Model = Schema.Struct({
  maybeHovered: Schema.Option(Node),
  maybeSelected: Schema.Option(Node),
  participants: Schema.Array(Participant),
  positions: Positions,
  trace: TraceData.schema,
  you: Schema.Option(ParticipantId),
});
export type Model = typeof Model.Type;
