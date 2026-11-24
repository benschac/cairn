import { readFileSync } from "node:fs";

import { Manifest, ManifestTask, TaskId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Hash, Option, Schema, String, Struct, pipe } from "effect";

import {
  STACKS_CLOSE,
  STACKS_OPEN,
  drawsOf,
  stackDiagramOf,
  withStackDiagram,
  type DiagramManifest,
  type DiagramTask,
} from "../src/index.ts";

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const id = (n: number): TaskId => TaskId.make(`t${n}`);
const ghost = TaskId.make("ghost");

/** A stable, non-negative number for a string, to point generated ids at a small pool. */
const hash = (text: string): number => Hash.string(text) >>> 0;

const Task = ManifestTask.mapFields(
  Struct.pick([
    "branch",
    "dependsOn",
    "humanGate",
    "id",
    "model",
    "parent",
    "specSections",
    "title",
    "worktree",
  ]),
);
const Plan = Schema.Array(Task).check(Schema.isMaxLength(14));

/**
 * Generated ids almost never refer to each other, so rename the tasks `t1`, `t2`, ... and point
 * each parent and dependency at one of them, or at a task that does not exist. Parents can form
 * cycles, and so can the stacks. The titles, branches and worktrees stay as generated.
 */
const planOf = (generated: typeof Plan.Type): ReadonlyArray<DiagramTask> => {
  const pool = Array.append(
    Array.map(generated, (_, index) => id(index + 1)),
    ghost,
  );
  const relink = (seed: string): TaskId =>
    Option.getOrElse(Array.get(pool, hash(seed) % pool.length), () => ghost);
  return Array.map(generated, (task, index) => ({
    ...task,
    dependsOn: Array.map(task.dependsOn, relink),
    id: id(index + 1),
    parent: Option.getOrNull(Option.map(Option.fromNullOr(task.parent), relink)),
  }));
};

const manifestOf = (tasks: ReadonlyArray<DiagramTask>): DiagramManifest => ({
  feature: Schema.decodeSync(Manifest.fields.feature)("demo"),
  tasks,
});

const NODE = /^ {4}(t\d+)\["/u;
const ARROW = /^ {2}(\w+) (-->|-\.->) (t\d+)$/u;

/** The task ids of each subgraph, in the order they are drawn. */
const subgraphsOf = (diagram: string): ReadonlyArray<ReadonlyArray<string>> =>
  Array.map(Array.drop(String.split(diagram, "\n  subgraph "), 1), (subgraph) =>
    Array.getSomes(
      Array.map(String.split(subgraph, "\n"), (line) =>
        Option.flatMap(String.match(NODE)(line), Array.get(1)),
      ),
    ),
  );

/** Every arrow of the diagram as `from kind to`. */
const arrowsOf = (diagram: string): ReadonlyArray<string> =>
  Array.filter(String.split(diagram, "\n"), (line) => Option.isSome(String.match(ARROW)(line)));

const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
  repo(".cairn/manifest.json"),
);

/** The diagram in `spec.md`: the fenced block between its markers. */
const drawnInSpec = (markdown: string): string =>
  pipe(
    String.split(markdown, `${STACKS_OPEN}\n\n`),
    Array.get(1),
    Option.flatMap((below) => Array.head(String.split(below, `\n\n${STACKS_CLOSE}`))),
    Option.map(String.replace(/^```mermaid\n/u, "")),
    Option.map(String.replace(/\n```$/u, "")),
    Option.getOrThrow,
  );

it("this repo's manifest draws the diagram in spec.md, byte for byte", () => {
  expect(stackDiagramOf(manifest)).toBe(drawnInSpec(repo(".cairn/spec.md")));
});

it("spec.md holds the markers once, and applying the diagram changes nothing", () => {
  const spec = repo(".cairn/spec.md");
  expect(Array.filter(String.split(spec, "\n"), (line) => line === STACKS_OPEN)).toHaveLength(1);
  expect(withStackDiagram(spec, manifest)).toBe(spec);
});

it.prop("every task is a node in exactly one subgraph", [Plan], ([generated]) => {
  const tasks = planOf(generated);
  const placed = Array.flatten(subgraphsOf(stackDiagramOf({ tasks })));
  expect(Array.sort(placed, String.Order)).toEqual(
    Array.sort(
      Array.map(tasks, (task) => task.id),
      String.Order,
    ),
  );
});

it.prop(
  "every parent is a solid arrow and every other dependency a dashed one, and nothing else is drawn",
  [Plan],
  ([generated]) => {
    const tasks = planOf(generated);
    const known = Array.map(tasks, (task) => task.id);
    const isKnown = (taskId: string) => Array.contains(known, taskId);
    const expected = Array.flatMap(tasks, (task) => {
      const parent = Option.filter(
        Option.fromNullOr(task.parent),
        (at) => isKnown(at) && at !== task.id,
      );
      const needs = Array.dedupe(
        Array.filter(
          task.dependsOn,
          (at) => isKnown(at) && at !== task.id && !Option.contains(parent, at),
        ),
      );
      return Option.isNone(parent) && Array.isReadonlyArrayEmpty(needs)
        ? [`  main --> ${task.id}`]
        : Array.appendAll(
            Array.map(Array.fromOption(parent), (at) => `  ${at} --> ${task.id}`),
            Array.map(needs, (at) => `  ${at} -.-> ${task.id}`),
          );
    });
    expect(Array.sort(arrowsOf(stackDiagramOf({ tasks })), String.Order)).toEqual(
      Array.sort(expected, String.Order),
    );
  },
);

it.prop(
  "the text draws, whatever the titles, branches and worktrees say",
  [Plan],
  ([generated]) => {
    expect(drawsOf(stackDiagramOf({ tasks: planOf(generated) }))).toEqual(Option.none());
  },
);

it.prop("the diagram does not depend on the order of the tasks", [Plan], ([generated]) => {
  const tasks = planOf(generated);
  expect(stackDiagramOf({ tasks: Array.reverse(tasks) })).toBe(stackDiagramOf({ tasks }));
});

const task = (n: number, model: string, required: boolean): DiagramTask => ({
  branch: `demo/${n}-slug`,
  dependsOn: [],
  humanGate: { reasons: required ? ["tag:human"] : [], required },
  id: id(n),
  model: Schema.decodeSync(ManifestTask.fields.model)(model),
  parent: null,
  specSections: Schema.decodeSync(ManifestTask.fields.specSections)(["spec.status.derivation"]),
  title: Schema.decodeSync(ManifestTask.fields.title)(`Task ${n}`),
  worktree: null,
});

it("a task's node shows its id, branch slug, GATE, title and worktree", () => {
  const diagram = stackDiagramOf({
    tasks: [task(1, "opus", true), { ...task(2, "sonnet", false), worktree: "wt-3" }],
  });
  expect(diagram).toContain('    t1["t1 · 1-slug · GATE<br/>Task 1<br/>main checkout"]');
  expect(diagram).toContain('    t2["t2 · 2-slug<br/>Task 2<br/>wt-3"]');
  expect(diagram).toContain('  subgraph s1["Stack 1 · status"]');
});

it("a class per model, one neutral class for any other model, and gate", () => {
  const diagram = stackDiagramOf({
    tasks: [
      task(1, "opus", true),
      task(2, "sonnet", false),
      task(3, "haiku", false),
      task(4, "gpt-5", false),
      task(5, "fable", true),
    ],
  });
  expect(diagram).toContain(
    "  class t1 opus\n  class t2 sonnet\n  class t3 haiku\n  class t4,t5 other\n  class t1,t5 gate",
  );
  expect(diagram).toContain("  classDef other fill:#e5e7eb,color:#111111,stroke:#6b7280");
  expect(drawsOf(diagram)).toEqual(Option.none());
});

it("a task with a quote, an angle bracket or a line break in its title still draws", () => {
  const diagram = stackDiagramOf({
    tasks: [
      {
        ...task(1, "opus", false),
        title: Schema.decodeSync(ManifestTask.fields.title)('Say "hi" <b>\nnow'),
      },
    ],
  });
  expect(diagram).toContain("Say #quot;hi#quot; #lt;b#gt; now");
  expect(drawsOf(diagram)).toEqual(Option.none());
});

/** Lines that are never a fence, a marker or a heading. */
const Line = Schema.String.check(Schema.isPattern(/^[a-z0-9 .,-]*$/u));
const Lines = Schema.Array(Line).check(Schema.isMaxLength(6));

const joined = (lines: ReadonlyArray<string>) => Array.join(lines, "\n");

it.prop(
  "withStackDiagram replaces what is between the markers and nothing outside them, and a second run changes nothing",
  { above: Lines, below: Lines, between: Lines, plan: Plan },
  ({ above, below, between, plan }) => {
    const tasks = planOf(plan);
    const stacks = manifestOf(tasks);
    const spec = joined(Array.flatten([above, [STACKS_OPEN], between, [STACKS_CLOSE], below]));
    const once = withStackDiagram(spec, stacks);
    expect(once).toBe(
      joined(
        Array.flatten([
          above,
          [STACKS_OPEN, "", "```mermaid", stackDiagramOf(stacks), "```", "", STACKS_CLOSE],
          below,
        ]),
      ),
    );
    expect(withStackDiagram(once, stacks)).toBe(once);
  },
);

it.prop(
  "a spec without markers keeps every line it had, gets the section once, and a second run changes nothing",
  { above: Lines, below: Lines, plan: Plan },
  ({ above, below, plan }) => {
    const stacks = manifestOf(planOf(plan));
    const acceptance = ["## Acceptance {#spec.acceptance}", "", "- Implements: `prd.demo`"];
    const spec = joined(Array.flatten([above, acceptance, below]));
    const once = withStackDiagram(spec, stacks);
    expect(String.startsWith(joined(above))(once)).toBe(true);
    expect(String.endsWith(joined(Array.appendAll(acceptance, below)))(once)).toBe(true);
    expect(once).toContain(
      `## Stacks {#spec.stacks}\n\n- Context: \`prd.demo\`\n\n${STACKS_OPEN}\n\n`,
    );
    expect(withStackDiagram(once, stacks)).toBe(once);
  },
);

it("without markers or an acceptance section, the section goes at the end", () => {
  const stacks = manifestOf([task(1, "opus", false)]);
  const once = withStackDiagram("# Spec {#spec.spec}\n\nText.\n", stacks);
  expect(
    String.startsWith("# Spec {#spec.spec}\n\nText.\n\n## Stacks {#spec.stacks}\n")(once),
  ).toBe(true);
  expect(String.endsWith(`${STACKS_CLOSE}\n`)(once)).toBe(true);
  expect(withStackDiagram(once, stacks)).toBe(once);
});

it("a marker inside a fence or a line of prose is not a marker", () => {
  const stacks = manifestOf([task(1, "opus", false)]);
  const spec = joined([
    "# Spec {#spec.spec}",
    `Write \`${STACKS_OPEN}\` above it.`,
    "```",
    STACKS_OPEN,
    STACKS_CLOSE,
    "```",
  ]);
  const once = withStackDiagram(spec, stacks);
  expect(String.startsWith(spec)(once)).toBe(true);
  expect(once).toContain("## Stacks {#spec.stacks}");
});
