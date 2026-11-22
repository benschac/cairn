import { ManifestTask, Participant } from "@cairn/contract";
import { Schema } from "effect";

export const Model = Schema.Struct({
  onlyWaiting: Schema.Boolean,
  participants: Schema.Array(Participant),
  rows: Schema.Array(Schema.toType(ManifestTask)),
  you: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;
