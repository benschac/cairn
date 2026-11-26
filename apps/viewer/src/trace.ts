import {
  JudgmentTarget,
  PrdSectionId,
  SectionId,
  TaskId,
  Verdict,
  type SectionStatus,
  type Trace,
  type TraceJudgment,
} from "@cairn/contract";
import { Array, HashSet, Option, Order, Record, Schema, String } from "effect";

/** A node in the viewer: a PRD or spec section, or a task. */
export const Node = Schema.Union([
  Schema.Struct({ id: SectionId, kind: Schema.Literal("section") }),
  Schema.Struct({ id: TaskId, kind: Schema.Literal("task") }),
]).pipe(Schema.toTaggedUnion("kind"));
export type Node = typeof Node.Type;

/** A node's kind and id, unique across the trace: "section:spec.viewer" or "task:t9". */
export const nodeKeyOf = (node: Node): string => `${node.kind}:${node.id}`;

export interface Chain {
  readonly prd: HashSet.HashSet<string>;
  readonly spec: HashSet.HashSet<string>;
  readonly tasks: HashSet.HashSet<string>;
}

const emptyChain = (): Chain => ({
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
  // A list item is shown inside its section, so a chain that reaches an item lights that section.
  const sectionOfItem: Links = Record.fromIterableWith(trace.prd.items, (item) => [
    item.id,
    [item.section],
  ]);
  const shownAs = (id: string): ReadonlyArray<string> =>
    Option.getOrElse(Record.get(sectionOfItem, id), () => [id]);
  const prdSectionsImplementedBy = (id: string): ReadonlyArray<string> =>
    Option.getOrElse(Record.get(implementsOf, id), () => []);

  const taskChain = (id: string): Chain =>
    Option.match(
      Array.findFirst(trace.tasks, (task) => task.id === id),
      {
        onNone: emptyChain,
        onSome: (task) => ({
          prd: HashSet.fromIterable(
            Array.flatMap(
              Array.appendAll(
                task.prdSections,
                Array.flatMap(task.specSections, prdSectionsImplementedBy),
              ),
              shownAs,
            ),
          ),
          spec: HashSet.fromIterable(task.specSections),
          tasks: HashSet.make(task.id),
        }),
      },
    );

  const prdChain = (id: string): Chain =>
    Option.match(
      Array.findFirst(trace.prd.sections, (section) => section.id === id),
      { onNone: emptyChain, onSome: () => linkedToPrd(id) },
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
      onNone: emptyChain,
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
/** A section's title, or its id when the trace has no section with that id. */
export const sectionTitleOf = (trace: Trace, id: SectionId): string =>
  Option.match(
    Array.findFirst(
      Array.appendAll(trace.prd.sections, trace.spec.sections),
      (candidate) => candidate.id === id,
    ),
    { onNone: () => id, onSome: (found) => found.title },
  );

/** A node's title: a section's, or a task's; the id when the trace has no such node. */
export const nodeTitleOf = (trace: Trace, node: Node): string =>
  Node.match(node, {
    section: ({ id }) => sectionTitleOf(trace, id),
    task: ({ id }) =>
      Option.match(
        Array.findFirst(trace.tasks, (task) => task.id === id),
        { onNone: () => id, onSome: (task) => task.title },
      ),
  });

/** The rollup status of a section, or none when the trace has none for it. */
export const sectionStatusOf = (trace: Trace, id: SectionId): Option.Option<SectionStatus> =>
  Option.map(
    Array.findFirst(trace.sections, (section) => section.id === id),
    (section) => section.status,
  );

/** The verdicts that put a marker on a node: anything but a pass. */
export const MarkVerdict = Verdict.pick(["flag", "unsure"]);

export const JudgmentMark = Schema.Struct({ stale: Schema.Boolean, verdict: MarkVerdict });
export type JudgmentMark = typeof JudgmentMark.Type;

const isMarkVerdict = Schema.is(MarkVerdict);

/** Whether a judgment is about the node: a section or task judgment with the node's id. */
const judges = (target: JudgmentTarget, node: Node): boolean =>
  JudgmentTarget.match(target, {
    draft: () => false,
    // A judgment names a spec section id, a narrower brand than the viewer's SectionId.
    section: ({ id }) => node.kind === "section" && String.Equivalence(node.id, id),
    stack: () => false,
    task: ({ id }) => node.kind === "task" && node.id === id,
  });

const markOf = (judgment: TraceJudgment): Option.Option<JudgmentMark> =>
  Option.map(Option.liftPredicate(judgment.verdict, isMarkVerdict), (verdict) => ({
    stale: judgment.stale,
    verdict,
  }));

/** `flag` ahead of `unsure`, then fresh ahead of stale: `false` orders before `true`. */
const markOrder: Order.Order<JudgmentMark> = Order.combine(
  Order.mapInput(Order.Boolean, (mark: JudgmentMark) => mark.verdict !== "flag"),
  Order.mapInput(Order.Boolean, (mark: JudgmentMark) => mark.stale),
);

/** The judgments about a node: those whose section or task target has the node's id. */
export const judgmentsOf = (trace: Trace, node: Node): ReadonlyArray<TraceJudgment> =>
  Array.filter(trace.judgments, (judgment) => judges(judgment.target, node));

/**
 * The judgment marker for a spec section or task: its worst judgment that is not a pass,
 * with `flag` ahead of `unsure`. A fresh judgment wins over a stale one of the same verdict.
 */
export const judgmentMarkOf = (trace: Trace, node: Node): Option.Option<JudgmentMark> =>
  Array.match(Array.getSomes(Array.map(judgmentsOf(trace, node), markOf)), {
    onEmpty: () => Option.none(),
    onNonEmpty: (marks) => Option.some(Array.min(marks, markOrder)),
  });
