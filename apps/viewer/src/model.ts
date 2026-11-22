import { Participant, ParticipantId, Trace } from "@cairn/contract";
import { Schema } from "effect";

export const Model = Schema.Struct({
  participants: Schema.Array(Participant),
  trace: Schema.toType(Trace),
  you: Schema.Option(ParticipantId),
});
export type Model = typeof Model.Type;
