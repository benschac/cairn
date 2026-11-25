import { Event, Manifest, SpecSectionId, Trace, TaskStatus } from "@cairn/contract";
import type { Actor } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, DateTime, Option, Schema, String, pipe } from "effect";

import { derive, traceOf } from "../src/index.ts";
import type { Rollup, TraceInput } from "../src/index.ts";

const PRD = Array.join(
  [
    "# Product {#prd.product}",
    "",
    "- Implements: `prd.fake`",
    "- Files: `not/in/prd.ts`",
    "",
    "## Viewer {#prd.viewer}",
    "",
    "## No id yet",
    "",
  ],
  "\n",
);

const SPEC = Array.join(
  [
    "# Spec {#spec.root}",
    "",
    "## Server {#spec.server}",
    "",
    "- Implements: `prd.viewer`",
    "- Files: `packages/cli/src/serve.ts`",
    "",
    "Serves the trace.",
    "",
    "### Routes {#spec.server.routes}",
    "",
    "<!-- human -->",
    "",
  ],
  "\n",
);

const task = (id: string, parent: string | null) => ({
  branch: `cairn-mvp/0${String.slice(1)(id)}-task`,
  commits: [],
  dependsOn: [],
  files: [`packages/core/src/${id}.ts`],
  humanGate: { reasons: [], required: false },
  id,
  model: "sonnet",
  parent,
  prdSections: ["prd.viewer"],
  reasoning: "low",
  sessions: [],
  specSections: ["spec.server"],
  status: "pending",
  title: `Task ${id}`,
  worktree: null,
});

const manifest = Schema.decodeUnknownSync(Manifest)({
  baseBranch: "main",
  feature: "cairn-mvp",
  tasks: [task("t2", null), task("t1", null)],
  version: 1,
});

/** A stand-in for the rollup: every section the documents hold, `pending`. */
const rollup: Rollup = (prd, spec) =>
  Array.getSomes(
    Array.map(Array.appendAll(prd, spec), ({ id }) =>
      Option.map(Option.fromUndefinedOr(id), (found) => ({
        id: found,
        status: "pending" as const,
      })),
    ),
  );

const inputOf = (
  events: ReadonlyArray<Event>,
  overrides: Partial<TraceInput> = {},
): TraceInput => ({
  commits: [],
  config: { humanPaths: [] },
  events,
  judgments: [],
  manifest,
  prd: PRD,
  rollup,
  spec: SPEC,
  specIndex: [],
  ...overrides,
});

const line = (taskId: string, status: TaskStatus, second: number, actor: Actor = "orchestrator") =>
  Schema.decodeSync(Event)({
    actor,
    status,
    taskId,
    ts: DateTime.formatIso(DateTime.makeUnsafe(second * 1000)),
  });

const Lines = Schema.Array(
  Schema.Struct({
    actor: Schema.Literals<ReadonlyArray<Actor>>(["orchestrator", "human:ben"]),
    status: TaskStatus,
    taskId: Schema.Literals(["t1", "t2", "t9"]),
  }),
).check(Schema.isMaxLength(12));

const encode = Schema.encodeSync(Trace);
const decode = Schema.decodeUnknownSync(Trace);

it.prop(
  "carries the derived tasks and warnings and survives its own schema",
  [Lines],
  ([lines]) => {
    const events = Array.map(lines, ({ actor, status, taskId }, second) =>
      line(taskId, status, second, actor),
    );
    const trace = traceOf(inputOf(events));
    const derived = derive(manifest, [], { humanPaths: [] }, events, []);
    expect(trace.tasks).toEqual(derived.tasks);
    expect(trace.warnings).toEqual(derived.warnings);
    expect(Array.map(trace.tasks, ({ id }) => id)).toEqual(["t2", "t1"]);
    expect(decode(encode(trace))).toEqual(trace);
  },
);

it("shows both documents with their sections, ids only", () => {
  const trace = traceOf(inputOf([]));
  expect(trace.prd.path).toBe(".cairn/prd.md");
  expect(trace.spec.path).toBe(".cairn/spec.md");
  expect(trace.prd.markdown).toBe(PRD);
  expect(trace.spec.markdown).toBe(SPEC);
  expect(Array.map(trace.prd.sections, ({ id }) => id)).toEqual(["prd.product", "prd.viewer"]);
  expect(Array.map(trace.spec.sections, ({ id }) => id)).toEqual([
    "spec.root",
    "spec.server",
    "spec.server.routes",
  ]);
  expect(Array.map(trace.sections, ({ id }) => id)).toEqual([
    "prd.product",
    "prd.viewer",
    "spec.root",
    "spec.server",
    "spec.server.routes",
  ]);
  expect(trace.baseBranch).toBe("main");
  expect(trace.feature).toBe("cairn-mvp");
  expect(trace.version).toBe(1);
  expect(trace.judgments).toEqual([]);
});

it("keeps the heading tree, keys and human marker of a spec section and none of a PRD section's", () => {
  const trace = traceOf(inputOf([]));
  const find = (id: string) =>
    pipe(
      Array.appendAll(trace.prd.sections, trace.spec.sections),
      Array.findFirst((section) => section.id === id),
      Option.getOrThrow,
    );
  expect(find("prd.product").keys).toEqual({
    context: [],
    defers: [],
    dependsOn: [],
    files: [],
    implements: [],
  });
  expect(find("prd.viewer").parent).toBe("prd.product");
  expect(find("spec.server").keys.implements).toEqual(["prd.viewer"]);
  expect(find("spec.server.routes").keys.files).toEqual(["packages/cli/src/serve.ts"]);
  expect(find("spec.server.routes").parent).toBe("spec.server");
  expect(find("spec.server.routes").human).toBe(true);
  expect(find("spec.server").human).toBe(false);
});

it("gives a spec section its summary from the index, and nothing else one", () => {
  const trace = traceOf(
    inputOf([], {
      specIndex: [
        {
          id: Schema.decodeSync(SpecSectionId)("spec.server"),
          summary: "Serves the trace over HTTP.",
        },
      ],
    }),
  );
  const summaries = Array.map(trace.spec.sections, ({ id, summary }) => [id, summary]);
  expect(summaries).toEqual([
    ["spec.root", null],
    ["spec.server", "Serves the trace over HTTP."],
    ["spec.server.routes", null],
  ]);
  expect(Array.every(trace.prd.sections, ({ summary }) => summary === null)).toBe(true);
});

it("takes the section statuses from the rollup it is given", () => {
  const trace = traceOf(
    inputOf([], {
      rollup: (prd, spec, tasks) =>
        Array.map(rollup(prd, spec, tasks), ({ id }) => ({
          id,
          status: tasks.length === 2 ? ("landed" as const) : ("pending" as const),
        })),
    }),
  );
  expect(Array.map(trace.sections, ({ status }) => status)).toEqual(Array.replicate("landed", 5));
});
