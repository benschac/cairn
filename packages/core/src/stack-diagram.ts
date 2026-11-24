import type { Manifest, ManifestTask, TaskId } from "@cairn/contract";
import { Array, Option, Order, Record, String, pipe } from "effect";

import { fencedOf, headingsOf, linesOf } from "./section-ids.ts";
import { TaskIdOrder, labelOf, stacksOf } from "./stacks.ts";

/** What the diagram reads from a task. A `ManifestTask` fits. */
export type DiagramTask = Pick<
  ManifestTask,
  | "branch"
  | "dependsOn"
  | "humanGate"
  | "id"
  | "model"
  | "parent"
  | "specSections"
  | "title"
  | "worktree"
>;

/** What the diagram reads from a manifest. A `Manifest` fits. */
export interface DiagramManifest extends Pick<Manifest, "feature"> {
  readonly tasks: ReadonlyArray<DiagramTask>;
}

/** The marker above the diagram in `spec.md`. */
export const STACKS_OPEN = "<!-- cairn:stacks -->";
/** The marker below it. */
export const STACKS_CLOSE = "<!-- /cairn:stacks -->";

/** The base branch's node, and the class of a task whose model has no colour of its own. */
const NEUTRAL = "fill:#e5e7eb,color:#111111,stroke:#6b7280";

/** The classes the diagram can draw, in the order it lists them: the models, then `gate`. */
const CLASSES: ReadonlyArray<readonly [name: string, style: string]> = [
  ["opus", "fill:#7c3aed,color:#ffffff,stroke:#4c1d95"],
  ["sonnet", "fill:#2563eb,color:#ffffff,stroke:#1e3a8a"],
  ["haiku", "fill:#facc15,color:#111111,stroke:#a16207"],
  ["other", NEUTRAL],
  ["gate", "stroke:#dc2626,stroke-width:5px"],
];

/** The class a task's model draws with: its own when the diagram has a colour for it, else `other`. */
const modelClassOf = (task: DiagramTask): string =>
  Array.contains(["opus", "sonnet", "haiku"], task.model) ? task.model : "other";

/** Text inside a quoted label: quotes and angle brackets as Mermaid entities, line breaks as spaces. */
const textOf = (text: string): string =>
  pipe(
    text,
    String.replaceAll(/\r\n|\r|\n/gu, " "),
    String.replaceAll('"', "#quot;"),
    String.replaceAll("<", "#lt;"),
    String.replaceAll(">", "#gt;"),
  );

/** `01-redact` for the branch `cairn-mvp/01-redact`. */
const slugOf = (branch: string): string =>
  pipe(
    String.split(branch, "/"),
    Array.last,
    Option.getOrElse(() => branch),
  );

/** A task's node: its ID, branch slug and `GATE` on the first line, its title, its worktree. */
const nodeOf = (task: DiagramTask): string =>
  `    ${task.id}["${Array.join(
    [
      `${textOf(task.id)} · ${textOf(slugOf(task.branch))}${task.humanGate.required ? " · GATE" : ""}`,
      textOf(task.title),
      textOf(Option.getOrElse(Option.fromNullOr(task.worktree), () => "main checkout")),
    ],
    "<br/>",
  )}"]`;

/**
 * The Mermaid text of the plan's stacks, the format of the diagram in `spec.planning.stack-order`.
 *
 * A `main` node, then a subgraph per stack from `stacksOf`, labelled `Stack N · area`, with its
 * tasks from the bottom row up. Then the arrows, task by task in ID order: a solid arrow from the
 * parent, a dashed one from every other dependency, and one from `main` for a task with neither.
 * An ID that names no task draws no arrow. Last, a class per model (`opus`, `sonnet`, `haiku`, or
 * `other` for any other model) and `gate`, each only when a task has it.
 *
 * It draws task IDs as they are, so an ID that is a Mermaid keyword does not draw. The planner
 * writes `t1`, `t2`, ....
 */
export const stackDiagramOf = (manifest: Pick<DiagramManifest, "tasks">): string => {
  const tasks = Array.dedupeWith(
    Array.sortWith(manifest.tasks, (task) => task.id, TaskIdOrder),
    (self: DiagramTask, that: DiagramTask) => self.id === that.id,
  );
  const byId = Record.fromIterableWith(tasks, (task) => [task.id, task]);
  const isTask = (id: TaskId): boolean => Record.has(byId, id);

  const subgraphs = Array.flatMap(stacksOf(tasks), (stack) =>
    Array.flatten([
      [`  subgraph s${stack.number}["${textOf(labelOf(stack))}"]`, "    direction BT"],
      pipe(
        Record.toEntries(stack.cells),
        Array.sortBy(
          Order.mapInput(Order.Number, ([, place]) => place.row),
          Order.mapInput(Order.Number, ([, place]) => place.column),
          Order.mapInput(TaskIdOrder, ([id]) => id),
        ),
        Array.flatMap(([id]) => Array.fromOption(Record.get(byId, id))),
        Array.map(nodeOf),
      ),
      ["  end"],
    ]),
  );

  const arrows = Array.flatMap(tasks, (task) => {
    const parent = pipe(
      Option.fromNullOr(task.parent),
      Option.filter((id) => id !== task.id && isTask(id)),
    );
    const needs = Array.sort(
      Array.dedupe(
        Array.filter(
          task.dependsOn,
          (id) => id !== task.id && isTask(id) && !Option.contains(parent, id),
        ),
      ),
      TaskIdOrder,
    );
    return Option.isNone(parent) && Array.isReadonlyArrayEmpty(needs)
      ? [`  main --> ${task.id}`]
      : Array.appendAll(
          Array.map(Array.fromOption(parent), (id) => `  ${id} --> ${task.id}`),
          Array.map(needs, (id) => `  ${id} -.-> ${task.id}`),
        );
  });

  const members = (name: string): ReadonlyArray<string> =>
    Array.map(
      Array.filter(tasks, (task) =>
        name === "gate" ? task.humanGate.required : modelClassOf(task) === name,
      ),
      (task) => task.id,
    );
  const used = Array.filter(CLASSES, ([name]) => Array.isReadonlyArrayNonEmpty(members(name)));

  return Array.join(
    Array.flatten([
      ["flowchart BT", '  main(["main"])'],
      subgraphs,
      arrows,
      Array.map(used, ([name]) => `  class ${Array.join(members(name), ",")} ${name}`),
      Array.map(used, ([name, style]) => `  classDef ${name} ${style}`),
      [`  style main ${NEUTRAL}`],
    ]),
    "\n",
  );
};

/** The diagram between its markers, as the lines `spec.md` holds. */
const blockOf = (manifest: Pick<DiagramManifest, "tasks">): ReadonlyArray<string> =>
  Array.flatten([
    [STACKS_OPEN, "", "```mermaid"],
    linesOf(stackDiagramOf(manifest)),
    ["```", "", STACKS_CLOSE],
  ]);

/** The lines outside a fence that are `marker`, as indexes. */
const markerLinesOf = (lines: ReadonlyArray<string>, marker: string): ReadonlyArray<number> => {
  const isMarker: ReadonlyArray<boolean> = Array.zipWith(
    lines,
    fencedOf(lines),
    (line, fenced) => !fenced && String.trim(line) === marker,
  );
  return Array.flatMap(isMarker, (is, index) => (is ? [index] : []));
};

/**
 * `spec` with the stack diagram of `manifest` between its markers.
 *
 * What is between the markers is replaced and nothing else changes. The markers are lines on
 * their own outside a fence: the first closing one that has an opening one above it, and the
 * nearest opening one. Without a pair, `spec` gets a `## Stacks {#spec.stacks}` section with the
 * markers, before `spec.acceptance` when there is one and at the end otherwise. Its `Context` key
 * names `prd.` and the manifest's feature, which is the slug of the PRD's title and so its top
 * section's ID.
 */
export const withStackDiagram = (spec: string, manifest: DiagramManifest): string => {
  const lines = linesOf(spec);
  const opens = markerLinesOf(lines, STACKS_OPEN);
  const block = blockOf(manifest);
  const pair = pipe(
    markerLinesOf(lines, STACKS_CLOSE),
    Array.findFirst((close) =>
      Option.map(
        Array.findLast(opens, (open) => open < close),
        (open) => ({ close, open }),
      ),
    ),
  );
  return Option.match(pair, {
    onNone: () => {
      const section = Array.flatten([
        ["## Stacks {#spec.stacks}", "", `- Context: \`prd.${manifest.feature}\``, ""],
        block,
      ]);
      const acceptance = Array.findFirstIndex(headingsOf(lines), (heading) =>
        Option.contains(
          Option.flatMap(heading, (found) => found.id),
          "spec.acceptance",
        ),
      );
      return Option.match(acceptance, {
        onNone: () => `${String.trimEnd(spec)}\n\n${Array.join(section, "\n")}\n`,
        onSome: (at) =>
          Array.join(
            Array.flatten([Array.take(lines, at), section, [""], Array.drop(lines, at)]),
            "\n",
          ),
      });
    },
    onSome: ({ close, open }) =>
      Array.join(
        Array.flatten([Array.take(lines, open), block, Array.drop(lines, close + 1)]),
        "\n",
      ),
  });
};
