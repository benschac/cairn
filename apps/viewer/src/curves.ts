import { SectionId, type TaskId, type Trace } from "@cairn/contract";
import { Position, getBezierPath } from "@xyflow/system";
import { Array, HashSet, Match, Option, Record, Schema, pipe } from "effect";

import { Node } from "./trace.ts";

/** A node's box in canvas coordinates, as measured from the DOM. */
export const Rect = Schema.Struct({
  height: Schema.Finite,
  width: Schema.Finite,
  x: Schema.Finite,
  y: Schema.Finite,
});
export type Rect = typeof Rect.Type;

/** Measured rects by node id: a section id for a `[data-section]` node, a task id for a `[data-task]` node. */
export const Positions = Schema.Record(Schema.String, Rect);
export type Positions = typeof Positions.Type;

/** What an edge stands for: PRD to spec, spec to task, or a parent or dependency in the stacks. */
export const EdgeKind = Schema.Literals(["implements", "specifies", "parent", "dependency"]);
export type EdgeKind = typeof EdgeKind.Type;

/** One edge to draw: an SVG path from the source node's anchor to the target node's anchor. */
export const Curve = Schema.Struct({
  dashed: Schema.Boolean,
  id: Schema.String,
  kind: EdgeKind,
  path: Schema.String,
  source: Node,
  target: Node,
});
export type Curve = typeof Curve.Type;

/** A link the trace calls for, before its ends are measured. */
interface Link {
  readonly dashed: boolean;
  readonly kind: EdgeKind;
  readonly source: Node;
  readonly sourcePosition: Position;
  readonly target: Node;
  readonly targetPosition: Position;
}

/** PRD to spec and spec to task: right edge to left edge. */
const across = (kind: EdgeKind, source: Node, target: Node): Link => ({
  dashed: false,
  kind,
  source,
  sourcePosition: Position.Right,
  target,
  targetPosition: Position.Left,
});

/** Within the stacks the lower task is the source: its top edge meets the upper task's bottom edge. */
const stacked = (kind: EdgeKind, source: TaskId, target: TaskId, dashed: boolean): Link => ({
  dashed,
  kind,
  source: { id: source, kind: "task" },
  sourcePosition: Position.Top,
  target: { id: target, kind: "task" },
  targetPosition: Position.Bottom,
});

/** A section node, when the id is one the viewer can show. */
const sectionNode = (id: string): Option.Option<Node> =>
  Option.map(SectionId.makeOption(id), (sectionId) => ({ id: sectionId, kind: "section" }));

const anchor = (rect: Rect, position: Position): { readonly x: number; readonly y: number } =>
  Match.value(position).pipe(
    Match.when(Position.Left, () => ({ x: rect.x, y: rect.y + rect.height / 2 })),
    Match.when(Position.Right, () => ({ x: rect.x + rect.width, y: rect.y + rect.height / 2 })),
    Match.when(Position.Top, () => ({ x: rect.x + rect.width / 2, y: rect.y })),
    Match.when(Position.Bottom, () => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height })),
    Match.exhaustive,
  );

const idOf = (link: Link): string => `${link.kind}:${link.source.id}>${link.target.id}`;

/** The curve for a link, or none when either end was not measured. */
const curveOf =
  (positions: Positions) =>
  (link: Link): Option.Option<Curve> =>
    Option.map(
      Option.all([Record.get(positions, link.source.id), Record.get(positions, link.target.id)]),
      ([from, to]) => {
        const a = anchor(from, link.sourcePosition);
        const b = anchor(to, link.targetPosition);
        const [path] = getBezierPath({
          sourcePosition: link.sourcePosition,
          sourceX: a.x,
          sourceY: a.y,
          targetPosition: link.targetPosition,
          targetX: b.x,
          targetY: b.y,
        });
        return {
          dashed: link.dashed,
          id: idOf(link),
          kind: link.kind,
          path,
          source: link.source,
          target: link.target,
        };
      },
    );

/**
 * One curve per link in the trace. PRD to spec and spec to task run from a right edge to a left
 * edge. In the stacks the lower task (the parent, or the dependency) is the source: its top edge
 * meets the upper task's bottom edge. A dependency is drawn only when it crosses columns, and is
 * dashed. A link whose endpoints are not both measured is skipped.
 */
export const curvesOf = (
  trace: Trace,
  positions: Positions,
  columnOf: (taskId: TaskId) => number,
): ReadonlyArray<Curve> => {
  const taskIds = HashSet.fromIterable(Array.map(trace.tasks, (task) => task.id));
  const isTask = (id: TaskId): boolean => HashSet.has(taskIds, id);

  const implementsLinks = Array.flatMap(trace.spec.sections, (section) =>
    Array.getSomes(
      Array.map(section.keys.implements, (prd) =>
        Option.map(sectionNode(prd), (source) =>
          across("implements", source, { id: section.id, kind: "section" }),
        ),
      ),
    ),
  );
  const taskLinks = Array.flatMap(trace.tasks, (task) =>
    Array.flatten([
      Array.getSomes(
        Array.map(task.specSections, (spec) =>
          Option.map(sectionNode(spec), (source) =>
            across("specifies", source, { id: task.id, kind: "task" }),
          ),
        ),
      ),
      pipe(
        Option.fromNullOr(task.parent),
        Option.filter(isTask),
        Option.map((parent) => stacked("parent", parent, task.id, false)),
        Option.toArray,
      ),
      pipe(
        task.dependsOn,
        Array.filter(
          (dependency) => isTask(dependency) && columnOf(dependency) !== columnOf(task.id),
        ),
        Array.map((dependency) => stacked("dependency", dependency, task.id, true)),
      ),
    ]),
  );

  return pipe(
    Array.appendAll(implementsLinks, taskLinks),
    Array.dedupeWith((a, b) => idOf(a) === idOf(b)),
    Array.map(curveOf(positions)),
    Array.getSomes,
  );
};
