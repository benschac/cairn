import { PrdSectionId, SectionId, SpecSectionId, TaskId, Trace } from "@cairn/contract";
import type { TraceSection } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Hash, HashSet, Option, Order, Record, Schema, String, Struct, pipe } from "effect";

import { demoTrace } from "../src/demo.ts";
import { stackLayoutOf } from "../src/stacks.ts";
import { type Curve, type EdgeKind, curvesOf } from "../src/curves.ts";
import type { Positions } from "../src/geometry.ts";

/** A stable, non-negative number for a string, to spread generated ids over small pools. */
const hash = (text: string): number => Hash.string(text) >>> 0;

const pick = <A>(items: ReadonlyArray<A>, seed: string): Option.Option<A> =>
  Array.isReadonlyArrayNonEmpty(items)
    ? Array.get(items, hash(seed) % items.length)
    : Option.none();

const emptySection: TraceSection = {
  human: false,
  id: Schema.decodeSync(SectionId)("prd.empty"),
  keys: { context: [], defers: [], dependsOn: [], files: [], implements: [] },
  level: 1,
  line: 1,
  parent: null,
  title: "",
};

const sectionOf = (id: string, implemented: TraceSection["keys"]["implements"]): TraceSection =>
  Struct.evolve(emptySection, {
    id: () => Schema.decodeSync(SectionId)(id),
    keys: (keys) => Struct.evolve(keys, { implements: () => implemented }),
  });

const prdPool = Array.map(["prd.a", "prd.b", "prd.c"], (id) => Schema.decodeSync(PrdSectionId)(id));
const specPool = Array.map(["spec.a", "spec.b", "spec.c"], (id) =>
  Schema.decodeSync(SpecSectionId)(id),
);
const specFor = (key: string): SpecSectionId => Option.getOrThrow(pick(specPool, key));
const ghost = Schema.decodeSync(TaskId)("ghost");

/**
 * Generated ids almost never refer to each other, so point every link at something that exists:
 * PRD and spec sections come from a small pool, parents and dependencies are other tasks.
 */
const linked = (trace: Trace): Trace => {
  const taskIds = Array.map(trace.tasks, (task) => task.id);
  return Struct.evolve(trace, {
    prd: (prd) =>
      Struct.evolve(prd, { sections: () => Array.map(prdPool, (id) => sectionOf(id, [])) }),
    spec: (spec) =>
      Struct.evolve(spec, {
        sections: () =>
          Array.map(specPool, (id, index) =>
            sectionOf(
              id,
              Array.filter(prdPool, (_, at) => (index + at + hash(trace.feature)) % 2 === 0),
            ),
          ),
      }),
    tasks: Array.map((task) =>
      Struct.evolve(task, {
        dependsOn: (ids) => Array.getSomes(Array.map(ids, (id) => pick(taskIds, id))),
        parent: (parent) =>
          pipe(
            Option.fromNullOr(parent),
            Option.flatMap((id) => pick(taskIds, id)),
            Option.getOrNull,
          ),
        specSections: Array.map(specFor),
      }),
    ),
  });
};

const keysOf = (trace: Trace): ReadonlyArray<string> =>
  Array.flatten<ReadonlyArray<ReadonlyArray<string>>>([
    Array.map(trace.prd.sections, (section) => section.id),
    Array.map(trace.spec.sections, (section) => section.id),
    Array.map(trace.tasks, (task) => task.id),
  ]);

/** Gives each key a distinct box, except those whose `omit` flag is true. */
const measure = (keys: ReadonlyArray<string>, omit: ReadonlyArray<boolean>): Positions =>
  Record.fromEntries(
    Array.flatMap(keys, (key, index) =>
      Option.contains(Array.get(omit, index), true)
        ? []
        : [[key, { height: 40, width: 100, x: index * 7, y: index * 13 }] as const],
    ),
  );

const columnOf = (taskId: string): number => hash(taskId) % 3;

const sortedIds = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.sort(ids, Order.String);

const idsOf = (curves: ReadonlyArray<Curve>): ReadonlyArray<string> =>
  sortedIds(Array.map(curves, (curve) => curve.id));

/** A link as kind, source id and target id. */
type Link = readonly [string, string, string];

/** The curve ids the trace calls for, worked out without looking at curvesOf. */
const expectedIds = (
  trace: Trace,
  positions: Positions,
  column: (id: string) => number,
): ReadonlyArray<string> => {
  const tasks = HashSet.fromIterable<string>(Array.map(trace.tasks, (task) => task.id));
  const isTask = (id: string): boolean => HashSet.has(tasks, id);
  const links = Array.flatten<ReadonlyArray<ReadonlyArray<Link>>>([
    Array.flatMap(trace.spec.sections, (section) =>
      Array.map(section.keys.implements, (prd) => ["implements", prd, section.id] as const),
    ),
    Array.flatMap(trace.tasks, (task) =>
      Array.flatten<ReadonlyArray<ReadonlyArray<Link>>>([
        Array.map(task.specSections, (spec) => ["specifies", spec, task.id] as const),
        Array.map(
          Option.toArray(Option.filter(Option.fromNullOr(task.parent), isTask)),
          (parent) => ["parent", parent, task.id] as const,
        ),
        Array.map(
          Array.filter(
            task.dependsOn,
            (dependency) => isTask(dependency) && column(dependency) !== column(task.id),
          ),
          (dependency) => ["dependency", dependency, task.id] as const,
        ),
      ]),
    ),
  ]);
  return pipe(
    links,
    Array.filter(
      ([, source, target]) => Record.has(positions, source) && Record.has(positions, target),
    ),
    Array.map(([kind, source, target]) => `${kind}:${source}>${target}`),
    Array.dedupe,
    sortedIds,
  );
};

const draw = (trace: Trace, omit: ReadonlyArray<boolean>, column = columnOf) => {
  const positions = measure(keysOf(trace), omit);
  return { curves: curvesOf(trace, positions, column), positions };
};

it.prop(
  "the curves are exactly the measured links in the trace, each drawn once",
  [Trace, Schema.Array(Schema.Boolean)],
  ([generated, omit]) => {
    const trace = linked(generated);
    const { curves, positions } = draw(trace, omit);
    expect(idsOf(curves)).toEqual(expectedIds(trace, positions, columnOf));
  },
);

it.prop("edge ids are unique", [Trace, Schema.Array(Schema.Boolean)], ([generated, omit]) => {
  const ids = Array.map(draw(linked(generated), omit).curves, (curve) => curve.id);
  expect(Array.dedupe(ids)).toEqual(ids);
});

it.prop(
  "no edge touches a node that was not measured",
  [Trace, Schema.Array(Schema.Boolean)],
  ([generated, omit]) => {
    const { curves, positions } = draw(linked(generated), omit);
    expect(
      Array.filter(
        curves,
        (curve) =>
          !Record.has(positions, curve.source.id) || !Record.has(positions, curve.target.id),
      ),
    ).toEqual([]);
  },
);

it.prop("with nothing measured there are no edges", [Trace], ([generated]) => {
  expect(curvesOf(linked(generated), {}, columnOf)).toEqual([]);
});

const byKind = (curves: ReadonlyArray<Curve>, kind: EdgeKind) =>
  Array.filter(curves, (curve) => curve.kind === kind);

/** The kinds of node each edge kind joins, source then target. */
const ends: Record.ReadonlyRecord<
  EdgeKind,
  readonly [Curve["source"]["kind"], Curve["target"]["kind"]]
> = {
  dependency: ["task", "task"],
  implements: ["section", "section"],
  parent: ["task", "task"],
  specifies: ["section", "task"],
};

it.prop(
  "an edge joins the kinds of node its kind names",
  [Trace, Schema.Array(Schema.Boolean)],
  ([generated, omit]) => {
    const { curves } = draw(linked(generated), omit);
    expect(Array.map(curves, (curve) => [curve.source.kind, curve.target.kind])).toEqual(
      Array.map(curves, (curve) => ends[curve.kind]),
    );
  },
);

it.prop(
  "parent edges are solid, dependency edges are dashed, and only dependencies across columns are drawn",
  [Trace, Schema.Array(Schema.Boolean)],
  ([generated, omit]) => {
    const { curves } = draw(linked(generated), omit);
    expect(Array.every(byKind(curves, "parent"), (curve) => !curve.dashed)).toBe(true);
    expect(Array.every(byKind(curves, "implements"), (curve) => !curve.dashed)).toBe(true);
    expect(Array.every(byKind(curves, "specifies"), (curve) => !curve.dashed)).toBe(true);
    expect(
      Array.every(
        byKind(curves, "dependency"),
        (curve) => curve.dashed && columnOf(curve.source.id) !== columnOf(curve.target.id),
      ),
    ).toBe(true);
  },
);

it.prop("a dependency within one column draws nothing", [Trace], ([generated]) => {
  const { curves } = draw(linked(generated), [], () => 0);
  expect(byKind(curves, "dependency")).toEqual([]);
});

it.prop(
  "a dependency or parent that is not a task of the trace draws nothing",
  [Trace],
  ([generated]) => {
    const trace = linked(generated);
    const stray = Struct.evolve(trace, {
      tasks: Array.map((task) =>
        Struct.evolve(task, { dependsOn: () => [], parent: () => task.id }),
      ),
    });
    const orphaned = Struct.evolve(trace, {
      tasks: Array.map((task) =>
        Struct.evolve(task, { dependsOn: () => [ghost], parent: () => ghost }),
      ),
    });
    const positions = measure(Array.append(keysOf(trace), "ghost"), []);
    expect(byKind(curvesOf(orphaned, positions, columnOf), "parent")).toEqual([]);
    expect(byKind(curvesOf(orphaned, positions, columnOf), "dependency")).toEqual([]);
    expect(byKind(curvesOf(stray, positions, columnOf), "parent")).toHaveLength(
      Array.dedupe(Array.map(trace.tasks, (task) => task.id)).length,
    );
  },
);

it.prop(
  "a curve leaves the source's anchor: right edge to left edge across columns, top to bottom in a stack",
  [Trace],
  ([generated]) => {
    const { curves, positions } = draw(linked(generated), []);
    Array.forEach(curves, (curve) => {
      const [from, to] = Option.getOrThrow(
        Option.all([
          Record.get(positions, curve.source.id),
          Record.get(positions, curve.target.id),
        ]),
      );
      const horizontal = curve.kind === "implements" || curve.kind === "specifies";
      const start = horizontal
        ? { x: from.x + from.width, y: from.y + from.height / 2 }
        : { x: from.x + from.width / 2, y: from.y };
      const end = horizontal
        ? { x: to.x, y: to.y + to.height / 2 }
        : { x: to.x + to.width / 2, y: to.y + to.height };
      expect(String.startsWith(`M${start.x},${start.y}`)(curve.path)).toBe(true);
      expect(String.endsWith(`${end.x},${end.y}`)(curve.path)).toBe(true);
    });
  },
);

it("the demo trace gives a solid edge per parent and a dashed one per cross-column dependency", () => {
  const layout = stackLayoutOf(demoTrace.tasks);
  const column = (id: TaskId): number =>
    Option.match(Record.get(layout, id), {
      onNone: () => 0,
      onSome: (position) => position.column,
    });
  const known = HashSet.fromIterable(Array.map(demoTrace.tasks, (task) => task.id));
  const curves = curvesOf(demoTrace, measure(keysOf(demoTrace), []), column);
  const parentIds = Array.flatMap(demoTrace.tasks, (task) =>
    Array.map(
      Option.toArray(Option.fromNullOr(task.parent)),
      (parent) => `parent:${parent}>${task.id}`,
    ),
  );
  const crossingIds = Array.flatMap(demoTrace.tasks, (task) =>
    Array.map(
      Array.filter(
        task.dependsOn,
        (dependency) => HashSet.has(known, dependency) && column(dependency) !== column(task.id),
      ),
      (dependency) => `dependency:${dependency}>${task.id}`,
    ),
  );
  expect(idsOf(Array.filter(curves, (curve) => curve.kind === "parent" && !curve.dashed))).toEqual(
    sortedIds(parentIds),
  );
  expect(idsOf(Array.filter(curves, (curve) => curve.dashed))).toEqual(sortedIds(crossingIds));
  expect(Array.isReadonlyArrayNonEmpty(parentIds)).toBe(true);
  expect(Array.isReadonlyArrayNonEmpty(crossingIds)).toBe(true);
});
