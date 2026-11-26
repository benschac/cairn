import { SectionId, TaskId } from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import { expect, it } from "@effect/vitest";
import { Array, Hash, HashSet, Option, Order, Record, Schema, String } from "effect";

import { arrowsOf, dependencyLinksOf, focusTaskOf, stackArrowsOf } from "../src/arrows.ts";
import { ArrowLink, BoxTask, endKeyInOf, stackBoxesOf } from "../src/boxes.ts";
import { demoTrace } from "../src/demo.ts";
import type { Rect } from "../src/geometry.ts";
import { unmeasuredWires } from "./fixtures.ts";

const Coordinate = Schema.Int.check(Schema.isBetween({ maximum: 600, minimum: -600 }));
const Size = Schema.Int.check(Schema.isBetween({ maximum: 120, minimum: 1 }));
const RectOf = Schema.Struct({ height: Size, width: Size, x: Coordinate, y: Coordinate });
/** Four keys that can be measured and a fifth, "e", that never is. */
const Measured = Schema.Struct({ a: RectOf, b: RectOf, c: RectOf, d: RectOf });
const Key = Schema.Literals(["a", "b", "c", "d", "e"]);
const Link = Schema.Struct({
  kind: Schema.Literals(["parent", "dependency"]),
  source: Key,
  target: Key,
});
const Links = Schema.Array(Link);
const Shift = Schema.Struct({ x: Coordinate, y: Coordinate });

/** The measured keys as the plain record `arrowsOf` takes. */
const boxesOf = (input: typeof Measured.Type): Record.ReadonlyRecord<string, Rect> => input;

const links = (input: ReadonlyArray<typeof Link.Type>): ReadonlyArray<ArrowLink> => input;

/** Whether the point is on the rectangle's boundary. */
const isOnEdge = (point: { x: number; y: number }, box: Rect): boolean => {
  const isInside =
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height;
  const isOnSide =
    point.x === box.x ||
    point.x === box.x + box.width ||
    point.y === box.y ||
    point.y === box.y + box.height;
  return isInside && isOnSide;
};

const moved = (box: Rect, by: { x: number; y: number }): Rect => ({
  ...box,
  x: box.x + by.x,
  y: box.y + by.y,
});

it.prop(
  "every arrow starts on an edge of its source's rectangle and ends on an edge of its target's, relative to the origin",
  [Links, Measured, RectOf],
  ([input, measured, origin]) => {
    const boxes = boxesOf(measured);
    Array.forEach(arrowsOf(links(input), boxes, origin), (arrow) => {
      const source = Option.getOrThrow(Record.get(boxes, arrow.source));
      const target = Option.getOrThrow(Record.get(boxes, arrow.target));
      expect(isOnEdge(arrow.from, moved(source, { x: -origin.x, y: -origin.y }))).toBe(true);
      expect(isOnEdge(arrow.to, moved(target, { x: -origin.x, y: -origin.y }))).toBe(true);
    });
  },
);

it.prop(
  "a link with an end not measured gives no arrow, and the others come in link order",
  [Links, Measured, RectOf],
  ([input, measured, origin]) => {
    const boxes = boxesOf(measured);
    expect(
      Array.map(arrowsOf(links(input), boxes, origin), (arrow) => [
        arrow.kind,
        arrow.source,
        arrow.target,
      ]),
    ).toEqual(
      Array.map(
        Array.filter(
          input,
          (link) => Record.has(boxes, link.source) && Record.has(boxes, link.target),
        ),
        (link) => [link.kind, link.source, link.target],
      ),
    );
  },
);

it.prop(
  "moving every rectangle and the origin by one offset gives the same arrows",
  [Links, Measured, RectOf, Shift],
  ([input, measured, origin, shift]) => {
    const boxes = boxesOf(measured);
    expect(
      arrowsOf(
        links(input),
        Record.map(boxes, (box) => moved(box, shift)),
        moved(origin, shift),
      ),
    ).toEqual(arrowsOf(links(input), boxes, origin));
  },
);

it("an arrow runs from the top of a lower source to the bottom of an upper target", () => {
  const [arrow] = arrowsOf(
    [{ kind: "parent", source: "low", target: "high" }],
    {
      high: { height: 20, width: 40, x: 100, y: 10 },
      low: { height: 20, width: 40, x: 100, y: 80 },
    },
    { height: 0, width: 0, x: 0, y: 0 },
  );
  expect(arrow?.from).toEqual({ x: 120, y: 80 });
  expect(arrow?.to).toEqual({ x: 120, y: 30 });
  expect(arrow?.path).toBe("M120,80 C120,55 120,55 120,30");
});

it("two rectangles level with each other are joined at their facing sides", () => {
  const [arrow] = arrowsOf(
    [{ kind: "parent", source: "left", target: "right" }],
    {
      left: { height: 20, width: 40, x: 0, y: 0 },
      right: { height: 20, width: 40, x: 100, y: 5 },
    },
    { height: 0, width: 0, x: 0, y: 0 },
  );
  expect(arrow?.from).toEqual({ x: 40, y: 10 });
  expect(arrow?.to).toEqual({ x: 100, y: 15 });
});

const id = (n: number): TaskId => TaskId.make(`t${n}`);
const ghost = TaskId.make("ghost");

/** A stable, non-negative number for a string, to point generated ids at a small pool. */
const hash = (text: string): number => Hash.string(text) >>> 0;

const Plan = Schema.Array(BoxTask).check(Schema.isMaxLength(16));

/**
 * Generated ids almost never refer to each other, so rename the tasks `t1`, `t2`, ... and point
 * each parent and dependency at one of them, or at a task that does not exist.
 */
const planOf = (generated: typeof Plan.Type): ReadonlyArray<BoxTask> => {
  const pool = Array.append(
    Array.map(generated, (_, index) => id(index + 1)),
    ghost,
  );
  const relink = (seed: string): TaskId =>
    Option.getOrElse(Array.get(pool, hash(seed) % Array.length(pool)), () => ghost);
  return Array.map(generated, (task, index) => ({
    dependsOn: Array.map(task.dependsOn, relink),
    id: id(index + 1),
    parent: Option.getOrNull(Option.map(Option.fromNullOr(task.parent), relink)),
    specSections: task.specSections,
    status: task.status,
  }));
};

/** Which of the plan's tasks is in focus, and whether every trunk is unfolded. */
const Focus = Schema.Struct({
  isUnfolded: Schema.Boolean,
  which: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const stackBoxes = (tasks: ReadonlyArray<BoxTask>, isUnfolded: boolean) =>
  stackBoxesOf(
    tasks,
    Record.fromIterableWith(stacksOf(tasks), (stack) => [stack.root, isUnfolded]),
  );

/** The task `which` picks from the plan, or none for an empty plan. */
const focusOf = (tasks: ReadonlyArray<BoxTask>, which: number): Option.Option<TaskId> =>
  Option.map(Array.get(tasks, which % Array.length(tasks)), (task) => task.id);

/** The stack a `task:<id>` or `segment:<root>` key is in. */
const stackOfKey = (boxes: ReturnType<typeof stackBoxes>, key: string): Option.Option<number> => {
  const name = Option.getOrElse(Array.last(String.split(key, ":")), () => "");
  return Option.map(
    Array.findFirst(boxes, (box) => Record.has(box.stack.cells, TaskId.make(name))),
    (box) => box.stack.number,
  );
};

it.prop(
  "with no focus there are no dependency links and nothing is lit",
  [Plan, Schema.Boolean],
  ([generated, isUnfolded]) => {
    const tasks = planOf(generated);
    const { links: found, lit } = dependencyLinksOf(
      { tasks },
      stackBoxes(tasks, isUnfolded),
      Option.none(),
    );
    expect(found).toEqual([]);
    expect(HashSet.size(lit)).toBe(0);
  },
);

it.prop(
  "every dependency link has the focus's end at one of its ends, and the tasks at the other ends are lit",
  [Plan, Focus],
  ([generated, { isUnfolded, which }]) => {
    const tasks = planOf(generated);
    const boxes = stackBoxes(tasks, isUnfolded);
    const focus = focusOf(tasks, which);
    const own = Option.map(focus, endKeyInOf(boxes));
    const { links: found, lit } = dependencyLinksOf({ tasks }, boxes, focus);
    Array.forEach(found, (link) => {
      expect(link.kind).toBe("dependency");
      expect(Option.exists(own, (key) => key === link.source || key === link.target)).toBe(true);
    });
    expect(Option.exists(focus, (task) => HashSet.has(lit, task))).toBe(false);
    // A link has a lit task at its other end, and every lit task is at the other end of a link.
    const ends = Array.flatMap(found, (link) => [link.source, link.target]);
    Array.forEach(Array.fromIterable(lit), (task) => {
      expect(Array.contains(ends, endKeyInOf(boxes)(task))).toBe(true);
    });
  },
);

it.prop(
  "no dependency link joins two tasks of one stack",
  [Plan, Focus],
  ([generated, { isUnfolded, which }]) => {
    const tasks = planOf(generated);
    const boxes = stackBoxes(tasks, isUnfolded);
    const { links: found } = dependencyLinksOf({ tasks }, boxes, focusOf(tasks, which));
    Array.forEach(found, (link) => {
      const [source, target] = [stackOfKey(boxes, link.source), stackOfKey(boxes, link.target)];
      expect(Option.isSome(source)).toBe(true);
      expect(Option.isSome(target)).toBe(true);
      expect(source).not.toEqual(target);
    });
  },
);

const demoBoxes = (isUnfolded: boolean) =>
  stackBoxesOf(
    demoTrace.tasks,
    Record.fromIterableWith(stacksOf(demoTrace.tasks), (stack) => [stack.root, isUnfolded]),
  );
const dependenciesOf = (isUnfolded: boolean, focus: string) =>
  dependencyLinksOf(demoTrace, demoBoxes(isUnfolded), Option.some(TaskId.make(focus)));

it("t52, in an unfolded Stack 24, has one link to t68 and lights it", () => {
  const { links: found, lit } = dependenciesOf(true, "t52");
  expect(found).toEqual([{ kind: "dependency", source: "task:t52", target: "task:t68" }]);
  expect(Array.fromIterable(lit)).toEqual(["t68"]);
});

it("t68, with Stack 24 folded, has its link from the segment, and its other two links", () => {
  const { links: found, lit } = dependenciesOf(false, "t68");
  expect(found).toContainEqual({ kind: "dependency", source: "segment:t45", target: "task:t68" });
  expect(found).toContainEqual({ kind: "dependency", source: "segment:t39", target: "task:t68" });
  expect(found).toContainEqual({ kind: "dependency", source: "task:t68", target: "task:t216" });
  expect(Array.length(found)).toBe(3);
  expect(Array.sort(Array.fromIterable(lit), String.Order)).toEqual(["t216", "t39", "t52"]);
});

it("a task that depends on the focus in its own stack draws no link", () => {
  // t69 depends on t52 and is built on it.
  const { links: found } = dependenciesOf(true, "t52");
  expect(Array.some(found, (link) => link.target === "task:t69")).toBe(false);
});

const node = (kind: "section" | "task", name: string) =>
  kind === "task"
    ? ({ id: TaskId.make(name), kind } as const)
    : ({ id: Schema.decodeSync(SectionId)(name), kind } as const);

it("the focus is the hovered task, else the open one, and a section is never it", () => {
  const hoveredTask = Option.some(node("task", "t52"));
  const openTask = [node("section", "spec.viewer"), node("task", "t68")];
  expect(focusTaskOf({ detail: [], maybeHovered: Option.none() })).toEqual(Option.none());
  expect(focusTaskOf({ detail: openTask, maybeHovered: Option.none() })).toEqual(
    Option.some("t68"),
  );
  expect(focusTaskOf({ detail: openTask, maybeHovered: hoveredTask })).toEqual(Option.some("t52"));
  expect(
    focusTaskOf({ detail: openTask, maybeHovered: Option.some(node("section", "spec.viewer")) }),
  ).toEqual(Option.some("t68"));
  expect(
    focusTaskOf({
      detail: [node("task", "t68"), node("section", "spec.viewer")],
      maybeHovered: Option.none(),
    }),
  ).toEqual(Option.none());
});

it("the dependency arrows come after every parent arrow, so they are drawn above them", () => {
  const boxes = demoBoxes(true);
  const { links: found } = dependenciesOf(true, "t68");
  const every: ReadonlyArray<ArrowLink> = Array.appendAll(
    Array.flatMap(boxes, (box) => box.arrows),
    found,
  );
  const keys = Array.dedupe(Array.flatMap(every, (link) => [link.source, link.target]));
  const rects = Record.fromEntries(
    Array.prepend(
      Array.map(
        keys,
        (key, index) => [key, { height: 20, width: 60, x: 10, y: 40 * index }] as const,
      ),
      ["stacks:list", { height: 4000, width: 100, x: 0, y: 0 }] as const,
    ),
  );
  const arrows = stackArrowsOf(
    boxes,
    Option.some({ boxes: rects, panes: unmeasuredWires.panes }),
    found,
  );
  const kinds = Array.map(arrows, (arrow) => arrow.kind);
  expect(Array.length(Array.filter(kinds, (kind) => kind === "dependency"))).toBe(3);
  expect(kinds).toEqual(Array.sortWith(kinds, (kind) => (kind === "parent" ? 0 : 1), Order.Number));
});
