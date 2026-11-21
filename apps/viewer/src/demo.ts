import { Schema } from "effect";

import { TaskRow } from "./model.ts";

export const demoRows = Schema.decodeUnknownSync(Schema.Array(TaskRow))([
  {
    status: "blocked_on_human",
    task: {
      gated: true,
      id: "task-1",
      section: "prd.data-model",
      title: "Add the sessions table",
    },
  },
  {
    status: "running",
    task: {
      gated: false,
      id: "task-2",
      section: "prd.plan-command",
      title: "Parse PRD sections",
    },
  },
  {
    status: "pending",
    task: {
      gated: false,
      id: "task-3",
      section: "prd.plan-command",
      title: "Write the stack",
    },
  },
]);
