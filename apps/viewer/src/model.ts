import { ManifestTask, Participant, ParticipantId } from "@cairn/contract";
import { Schema } from "effect";

export const Model = Schema.Struct({
  onlyWaiting: Schema.Boolean,
  participants: Schema.Array(Participant),
  rows: Schema.Array(Schema.toType(ManifestTask)),
  you: Schema.Option(ParticipantId),
});
export type Model = typeof Model.Type;
