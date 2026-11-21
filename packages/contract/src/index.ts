import { Schema } from "effect";

export const SectionId = Schema.NonEmptyString.pipe(Schema.brand("SectionId"));
export type SectionId = typeof SectionId.Type;

export const TaskId = Schema.NonEmptyString.pipe(Schema.brand("TaskId"));
export type TaskId = typeof TaskId.Type;

export const TaskStatus = Schema.Literals([
  "pending",
  "running",
  "blocked_on_human",
  "done",
  "landed",
]);
export type TaskStatus = typeof TaskStatus.Type;

export const Task = Schema.Struct({
  gated: Schema.Boolean,
  id: TaskId,
  section: SectionId,
  title: Schema.NonEmptyString,
});
export type Task = typeof Task.Type;

export const TaskEvents = {
  approve: Schema.Struct({}),
  finish: Schema.Struct({}),
  land: Schema.Struct({}),
  start: Schema.Struct({}),
};

export const TaskEventType = Schema.Literals(["approve", "finish", "land", "start"]);
export type TaskEventType = typeof TaskEventType.Type;
