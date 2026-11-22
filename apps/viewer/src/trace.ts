import { SectionId, TaskId, type Trace } from "@cairn/contract";
import { Schema } from "effect";

/** A node in the viewer: a PRD or spec section, or a task. */
export const Node = Schema.Union([
  Schema.Struct({ id: SectionId, kind: Schema.Literal("section") }),
  Schema.Struct({ id: TaskId, kind: Schema.Literal("task") }),
]);
export type Node = typeof Node.Type;

export interface Chain {
  readonly prd: ReadonlySet<string>;
  readonly spec: ReadonlySet<string>;
  readonly tasks: ReadonlySet<string>;
}

const empty = (): Chain => ({ prd: new Set(), spec: new Set(), tasks: new Set() });

const includes = (ids: ReadonlyArray<string>, id: string): boolean => ids.includes(id);

const isPrd = (id: string): boolean => id.startsWith("prd.");

/**
 * The PRD sections, spec sections and tasks linked to a node, in both directions.
 *
 * Links are exact ids, one hop through spec sections. The chain does not follow
 * sections under a heading: keys are already inherited down the tree in
 * TraceSection, so a child spec section implements what its parent implements,
 * and following descendants again would break the symmetry of the links.
 * A task contributes the PRD sections it names and those its spec sections implement.
 * An unknown node has an empty chain; a known node is in its own chain.
 */
export const chainOf = (trace: Trace, node: Node): Chain => {
  const implementsOf = new Map<string, ReadonlyArray<string>>(
    trace.spec.sections.map((section) => [section.id, section.keys.implements]),
  );

  if (node.kind === "task") {
    const task = trace.tasks.find((candidate) => candidate.id === node.id);
    if (task === undefined) {
      return empty();
    }
    const prd = new Set<string>(task.prdSections);
    for (const id of task.specSections) {
      for (const implemented of implementsOf.get(id) ?? []) {
        prd.add(implemented);
      }
    }
    return { prd, spec: new Set<string>(task.specSections), tasks: new Set([task.id]) };
  }

  if (isPrd(node.id)) {
    if (!trace.prd.sections.some((section) => section.id === node.id)) {
      return empty();
    }
    const spec = new Set<string>(
      trace.spec.sections
        .filter((section) => includes(section.keys.implements, node.id))
        .map((section) => section.id),
    );
    const tasks = new Set<string>(
      trace.tasks
        .filter(
          (task) =>
            includes(task.prdSections, node.id) || task.specSections.some((id) => spec.has(id)),
        )
        .map((task) => task.id),
    );
    return { prd: new Set([node.id]), spec, tasks };
  }

  if (!implementsOf.has(node.id)) {
    return empty();
  }
  return {
    prd: new Set<string>(implementsOf.get(node.id) ?? []),
    spec: new Set([node.id]),
    tasks: new Set<string>(
      trace.tasks.filter((task) => includes(task.specSections, node.id)).map((task) => task.id),
    ),
  };
};

export const isInChain = (chain: Chain, node: Node): boolean =>
  node.kind === "task"
    ? chain.tasks.has(node.id)
    : chain.prd.has(node.id) || chain.spec.has(node.id);
