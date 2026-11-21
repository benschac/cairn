import { Participant, Task, TaskStatus } from "@cairn/contract";
import { Schema } from "effect";

export const TaskRow = Schema.Struct({
  status: TaskStatus,
  task: Schema.toType(Task),
});
export type TaskRow = typeof TaskRow.Type;

export const Model = Schema.Struct({
  onlyWaiting: Schema.Boolean,
  participants: Schema.Array(Participant),
  rows: Schema.Array(TaskRow),
  you: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;
