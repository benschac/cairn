import { Schema } from "effect";

import { TaskDraft } from "./manifest.ts";

/** A list of drafts as JSON text: what the planner's tasks call replies with. */
export const TaskDraftsJson = Schema.fromJsonString(Schema.Array(TaskDraft));
