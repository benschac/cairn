import { ManifestTask, Trace } from "@cairn/contract";
import { Schema } from "effect";

import demoTraceJson from "./demo-trace.json" with { type: "json" };

export const demoTrace = Schema.decodeUnknownSync(Trace)(demoTraceJson);

export const demoRows = Schema.decodeUnknownSync(Schema.Array(ManifestTask))([
  {
    branch: "demo/01-add-the-sessions-table",
    commits: [],
    dependsOn: [],
    files: [],
    humanGate: { reasons: ["tag:human"], required: true },
    id: "t1",
    model: "sonnet",
    parent: null,
    prdSections: ["prd.data-model"],
    reasoning: "medium",
    sessions: [],
    specSections: ["spec.data-model"],
    status: "blocked_on_human",
    title: "Add the sessions table",
    worktree: null,
  },
  {
    branch: "demo/02-parse-prd-sections",
    commits: [],
    dependsOn: [],
    files: [],
    humanGate: { reasons: [], required: false },
    id: "t2",
    model: "sonnet",
    parent: null,
    prdSections: ["prd.plan-command"],
    reasoning: "medium",
    sessions: [],
    specSections: ["spec.plan-command"],
    status: "running",
    title: "Parse PRD sections",
    worktree: null,
  },
  {
    branch: "demo/03-write-the-stack",
    commits: [],
    dependsOn: [],
    files: [],
    humanGate: { reasons: [], required: false },
    id: "t3",
    model: "sonnet",
    parent: null,
    prdSections: ["prd.plan-command"],
    reasoning: "medium",
    sessions: [],
    specSections: ["spec.plan-command"],
    status: "pending",
    title: "Write the stack",
    worktree: null,
  },
]);
