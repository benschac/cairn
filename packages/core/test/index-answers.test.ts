import { readFileSync } from "node:fs";

import { Event, Manifest, SpecIndex, SpecSectionId, PrdSectionId, TaskId } from "@cairn/contract";
import type { TaskStatus } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, DateTime, Option, Record, Schema, String, Struct } from "effect";

import { indexOf, lint, rollupOf, stacksOf, traceOf } from "../src/index.ts";
import type { StatusOf } from "../src/index.ts";

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const PRD = Array.join(
  [
    "# Product {#prd.product}",
    "",
    "## Viewer {#prd.viewer}",
    "",
    "Done when:",
    "",
    "- It shows. {#prd.viewer#v1}",
    "",
  ],
  "\n",
);
const SPEC = Array.join(
  ["# Spec {#spec.root}", "", "## Server {#spec.server}", "", "- Implements: `prd.viewer`", ""],
  "\n",
);

const Pointer = Schema.Int.check(Schema.isBetween({ maximum: 7, minimum: 0 }));

/** Tasks that need any others, themselves included, so some close a cycle; each pending, running or done. */
const Plan = Schema.Array(
  Schema.Struct({
    needs: Schema.Array(Pointer).check(Schema.isMaxLength(3)),
    progress: Schema.Literals([0, 1, 2]),
  }),
).check(Schema.isMinLength(1), Schema.isMaxLength(8));
type Plan = typeof Plan.Type;

const idAt = (at: number) => TaskId.make(`t${at + 1}`);

const manifestOf = (plan: Plan): Manifest =>
  Schema.decodeUnknownSync(Manifest)({
    baseBranch: "main",
    feature: "product",
    tasks: Array.map(plan, ({ needs }, at) => ({
      branch: `product/0${at + 1}-task`,
      commits: [],
      dependsOn: Array.dedupe(
        Array.map(
          Array.filter(needs, (need) => need < Array.length(plan)),
          idAt,
        ),
      ),
      files: [],
      humanGate: { reasons: [], required: false },
      id: idAt(at),
      model: "sonnet",
      parent: null,
      prdSections: ["prd.viewer"],
      reasoning: "low",
      sessions: [],
      specSections: ["spec.server"],
      status: "pending",
      title: `Task ${at + 1}`,
      worktree: null,
    })),
    version: 1,
  });

const PROGRESS: ReadonlyArray<ReadonlyArray<TaskStatus>> = [[], ["running"], ["running", "done"]];

const eventsOf = (plan: Plan): ReadonlyArray<Event> =>
  Array.flatMap(plan, ({ progress }, at) =>
    Array.map(
      Option.getOrElse(Array.get(PROGRESS, progress), () => []),
      (status, step) =>
        Schema.decodeSync(Event)({
          status,
          taskId: idAt(at),
          ts: DateTime.formatIso(DateTime.makeUnsafe((10 * at + step) * 1000)),
        }),
    ),
  );

const traceFor = (plan: Plan) =>
  traceOf({
    commits: [],
    config: { humanPaths: [] },
    events: eventsOf(plan),
    judgments: [],
    manifest: manifestOf(plan),
    notes: [],
    prd: PRD,
    rollup: rollupOf,
    spec: SPEC,
    specIndex: [],
  });

const SPEC_INDEX = {
  sections: [
    {
      dependsOn: [],
      id: SpecSectionId.make("spec.server"),
      implements: [PrdSectionId.make("prd.viewer")],
      tests: [],
    },
  ],
};

it.prop(
  "the trace that cairn status --json prints, the index the viewer builds from it and the index of the files agree on what each task waits on (spec.status.answers-from-the-index#t1)",
  [Plan],
  ([plan]) => {
    const manifest = manifestOf(plan);
    const trace = traceFor(plan);
    const statuses = Record.fromIterableWith(
      trace.tasks,
      (task) => [task.id, task.status] as const,
    );
    const statusOf: StatusOf = (task) =>
      Option.getOrElse(Record.get(statuses, task), () => "pending");
    const fromTrace = indexOf({ trace });
    const fromFiles = indexOf({ manifest, prd: PRD, specIndex: SPEC_INDEX });
    Array.forEach(trace.tasks, (task) => {
      expect(task.waitsOn).toEqual(fromTrace.waitsOn(task.id, statusOf));
      expect(task.waitsOn).toEqual(fromFiles.waitsOn(task.id, statusOf));
      expect(task.waitedOnBy).toEqual(fromTrace.waitedOnBy(task.id, statusOf));
      expect(task.waitedOnBy).toEqual(fromFiles.waitedOnBy(task.id, statusOf));
      expect(task.canStart).toBe(fromTrace.canStart(task.id, statusOf));
      expect(task.canStart).toBe(fromFiles.canStart(task.id, statusOf));
    });
    expect(stacksOf(trace.tasks, fromTrace)).toEqual(stacksOf(trace.tasks));
  },
);

it.prop(
  "lint's need-cycle findings are the index's cycles, one finding each (spec.status.answers-from-the-index#t1)",
  [Plan],
  ([plan]) => {
    const manifest = manifestOf(plan);
    const findings = Array.filter(
      lint(PRD, SPEC, Option.some(manifest), { humanPaths: [] }),
      ({ rule }) => rule === "need-cycle",
    );
    const cycles = indexOf({ manifest, prd: PRD, specIndex: SPEC_INDEX }).cycles;
    expect(
      Array.map(findings, ({ message }) =>
        String.split(
          Option.getOrElse(Array.head(String.split(message, " need")), () => ""),
          ", ",
        ),
      ),
    ).toEqual(cycles);
    Array.forEach(findings, ({ file, severity }) => {
      expect(file).toBe("manifest.json");
      expect(severity).toBe("error");
    });
  },
);

it("this repo's manifest with t71 made to depend on t73 fails lint with an error naming t71, t72 and t73 (spec.status.answers-from-the-index#t2, prd.relations.index#v1)", () => {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    repo(".cairn/manifest.json"),
  );
  const specIndex = Schema.decodeUnknownSync(Schema.fromJsonString(SpecIndex))(
    repo(".cairn/spec.json"),
  );
  const t73 = TaskId.make("t73");
  const broken = Struct.evolve(manifest, {
    tasks: (tasks) =>
      Array.map(tasks, (task) =>
        task.id === "t71"
          ? Struct.evolve(task, { dependsOn: (dependsOn) => Array.append(dependsOn, t73) })
          : task,
      ),
  });
  const cycles = (plan: Manifest) =>
    Array.filter(
      lint(
        repo(".cairn/prd.md"),
        repo(".cairn/spec.md"),
        Option.some(plan),
        { humanPaths: [] },
        Option.some(specIndex),
      ),
      ({ rule }) => rule === "need-cycle",
    );
  expect(cycles(manifest)).toEqual([]);
  expect(cycles(broken)).toEqual([
    {
      file: "manifest.json",
      line: Option.none(),
      message: "t71, t72, t73 need each other in a cycle.",
      rule: "need-cycle",
      severity: "error",
    },
  ]);
});
