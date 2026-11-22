import { PrdSectionId, SectionId, TaskId, type Trace } from "@cairn/contract";
import { Array, HashSet, Option, Record, Schema } from "effect";

/** A node in the viewer: a PRD or spec section, or a task. */
export const Node = Schema.Union([
  Schema.Struct({ id: SectionId, kind: Schema.Literal("section") }),
  Schema.Struct({ id: TaskId, kind: Schema.Literal("task") }),
]).pipe(Schema.toTaggedUnion("kind"));
export type Node = typeof Node.Type;

export interface Chain {
  readonly prd: HashSet.HashSet<string>;
  readonly spec: HashSet.HashSet<string>;
  readonly tasks: HashSet.HashSet<string>;
}

const empty = (): Chain => ({
  prd: HashSet.empty(),
  spec: HashSet.empty(),
  tasks: HashSet.empty(),
});

const isPrdSection = Schema.is(PrdSectionId);

/** The PRD sections each spec section implements, by spec section id. */
type Links = Record.ReadonlyRecord<string, ReadonlyArray<string>>;

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
  const implementsOf: Links = Record.fromIterableWith(trace.spec.sections, (section) => [
    section.id,
    section.keys.implements,
  ]);
  const implementedBy = (id: string): ReadonlyArray<string> =>
    Option.getOrElse(Record.get(implementsOf, id), () => []);

  const taskChain = (id: string): Chain =>
    Option.match(
      Array.findFirst(trace.tasks, (task) => task.id === id),
      {
        onNone: empty,
        onSome: (task) => ({
          prd: HashSet.fromIterable(
            Array.appendAll(task.prdSections, Array.flatMap(task.specSections, implementedBy)),
          ),
          spec: HashSet.fromIterable(task.specSections),
          tasks: HashSet.make(task.id),
        }),
      },
    );

  const prdChain = (id: string): Chain =>
    Option.match(
      Array.findFirst(trace.prd.sections, (section) => section.id === id),
      { onNone: empty, onSome: () => linkedToPrd(id) },
    );

  const linkedToPrd = (id: string): Chain => {
    const spec = HashSet.fromIterable<string>(
      Array.map(
        Array.filter(trace.spec.sections, (section) => Array.contains(section.keys.implements, id)),
        (section) => section.id,
      ),
    );
    const tasks = HashSet.fromIterable(
      Array.map(
        Array.filter(
          trace.tasks,
          (task) =>
            Array.contains(task.prdSections, id) ||
            Array.some(task.specSections, (specId) => HashSet.has(spec, specId)),
        ),
        (task) => task.id,
      ),
    );
    return { prd: HashSet.make(id), spec, tasks };
  };

  const specChain = (id: string): Chain =>
    Option.match(Record.get(implementsOf, id), {
      onNone: empty,
      onSome: (implemented) => ({
        prd: HashSet.fromIterable(implemented),
        spec: HashSet.make(id),
        tasks: HashSet.fromIterable(
          Array.map(
            Array.filter(trace.tasks, (task) => Array.contains(task.specSections, id)),
            (task) => task.id,
          ),
        ),
      }),
    });

  return Node.match(node, {
    section: ({ id }) => (isPrdSection(id) ? prdChain(id) : specChain(id)),
    task: ({ id }) => taskChain(id),
  });
};

export const isInChain = (chain: Chain, node: Node): boolean =>
  Node.match(node, {
    section: ({ id }) => HashSet.has(chain.prd, id) || HashSet.has(chain.spec, id),
    task: ({ id }) => HashSet.has(chain.tasks, id),
  });
