import {
  SectionId,
  PrdSectionId,
  type Reasoning,
  SectionStatus,
  TaskId,
  Trace,
  TraceSection,
  TraceTask,
  type TaskStatus,
} from "@cairn/contract";
import { indexOf } from "@cairn/core/relation-index";
import type { RelationIndex } from "@cairn/core/relation-index";
import { sectionLinkerOf, type SectionLinker, type SectionLinks } from "@cairn/core/section-links";
import { TaskIdOrder } from "@cairn/core/stacks";
import {
  Array,
  DateTime,
  HashSet,
  Match,
  MutableHashMap,
  MutableRef,
  Option,
  Order,
  Record,
  Schema,
  String,
  pipe,
} from "effect";

import type { Density } from "./model.ts";
import { blockKeyOf, type SearchResult } from "./search.ts";
import { Node, chainOf } from "./trace.ts";

/** The last trace the index was built for, with its index. */
const relationsCache = MutableRef.make<
  Option.Option<{ readonly index: RelationIndex; readonly trace: Trace }>
>(Option.none());

/**
 * The relation index of `trace`, built with `indexOf({ trace })` (see
 * `spec.status.answers-from-the-index`). The reader asks it what the trace does not carry: section
 * links, and what a task needs or is needed by, directly or not. Every render reads the same trace
 * until a new one arrives, so the index is built once per trace.
 */
export const relationsOf = (trace: Trace): RelationIndex =>
  Option.getOrElse(
    Option.map(
      Option.filter(MutableRef.get(relationsCache), (cached) => cached.trace === trace),
      ({ index }) => index,
    ),
    () => {
      const index = indexOf({ trace });
      MutableRef.set(relationsCache, Option.some({ index, trace }));
      return index;
    },
  );

/** What the links of a trace's sections are built from, kept for as long as the trace is the same one. */
interface LinksCache {
  /** The plan-wide part, worked out once for the trace; each section's answer is then quick. */
  readonly linker: SectionLinker;
  readonly links: MutableHashMap.MutableHashMap<string, SectionLinks>;
  readonly trace: Trace;
}

const linksCache = MutableRef.make<Option.Option<LinksCache>>(Option.none());

const linksCacheOf = (trace: Trace): LinksCache =>
  Option.getOrElse(
    Option.filter(MutableRef.get(linksCache), (cached) => cached.trace === trace),
    () => {
      const statuses = Record.fromIterableWith(trace.tasks, (task) => [task.id, task.status]);
      const fresh: LinksCache = {
        linker: sectionLinkerOf(
          relationsOf(trace),
          { items: trace.prd.items, sections: trace.prd.sections, spec: trace.spec.sections },
          (task) => Option.getOrElse(Record.get(statuses, task), (): TaskStatus => "pending"),
        ),
        links: MutableHashMap.empty(),
        trace,
      };
      MutableRef.set(linksCache, Option.some(fresh));
      return fresh;
    },
  );

/**
 * What the PRD section or item `id` needs, what needs it and what it can build next, from
 * `sectionLinkerOf` on the trace's relation index (see `spec.viewer.what-depends-on-what`).
 * `isTransitive` asks for everything before and after, each with the link it comes through. Each
 * answer is kept with its trace, so a render that asks again for the same one does no work.
 */
export const linksFor = (trace: Trace, id: PrdSectionId, isTransitive: boolean): SectionLinks => {
  const cache = linksCacheOf(trace);
  const key = `${isTransitive ? "all" : "direct"}:${id}`;
  return Option.getOrElse(MutableHashMap.get(cache.links, key), () => {
    const links = cache.linker(id, isTransitive);
    MutableHashMap.set(cache.links, key, links);
    return links;
  });
};

/**
 * The end of a heading's status line or an item's annotation: `needs 3 · needed by 1`, then
 * `2 ready` when the section has unfinished tasks and some can start, or `waiting` when none can.
 */
export const linksTextOf = (links: SectionLinks): string =>
  Array.join(
    Array.appendAll(
      [`needs ${Array.length(links.needs)}`, `needed by ${Array.length(links.neededBy)}`],
      Array.isReadonlyArrayEmpty(links.next)
        ? []
        : [links.ready === 0 ? "waiting" : `${links.ready} ready`],
    ),
    " · ",
  );

const isTaskId = Schema.is(TaskId);

/** The tasks that need `task` directly, finished or not, in task order. */
export const neededByOf = (trace: Trace, task: TaskId): ReadonlyArray<TaskId> =>
  Array.sort(
    Array.dedupe(
      Array.filter(
        Array.flatMap(relationsOf(trace).into(task, "needs"), ({ from }) =>
          from.kind === "task" ? [from.id] : [],
        ),
        isTaskId,
      ),
    ),
    TaskIdOrder,
  );

/** What a person chose that decides the current section: the model's `reader`, as far as it goes. */
export interface Choice {
  readonly maybeAtTop: Option.Option<PrdSectionId>;
  readonly maybePinned: Option.Option<PrdSectionId>;
}

/**
 * The current section: the active search result's PRD section when there is one, else the pinned
 * section, else the one at the top of the PRD pane.
 */
export const currentOf = (
  reader: Choice,
  maybeSearched: Option.Option<PrdSectionId>,
): Option.Option<PrdSectionId> =>
  maybeSearched.pipe(
    Option.orElse(() => reader.maybePinned),
    Option.orElse(() => reader.maybeAtTop),
  );

const isPrdSection = Schema.is(PrdSectionId);

/**
 * The PRD section a search result puts in front of the reader: the section itself for a PRD
 * section, and for any other node the first PRD section of its chain in document order. None when
 * nothing is active, and for a node whose chain has no PRD section. The document's title is not a
 * section a reader can be on, so it is never the answer.
 */
export const searchedSectionOf = (
  trace: Trace,
  maybeActive: Option.Option<Node>,
): Option.Option<PrdSectionId> =>
  Option.flatMap(maybeActive, (node) => {
    const chain = chainOf(trace, node);
    return Array.findFirst(
      trace.prd.sections,
      (section) => section.level > 1 && HashSet.has(chain.prd, section.id),
    ).pipe(Option.flatMap((section) => Option.liftPredicate(section.id, isPrdSection)));
  });

/** Whether a result is a spec section that implements no PRD section, which has no card in the reader. */
export const isCardless = (trace: Trace, node: Node): boolean =>
  Node.match(node, {
    section: ({ id }) =>
      !isPrdSection(id) && Option.isNone(searchedSectionOf(trace, Option.some(node))),
    task: () => false,
  });

/**
 * Where to bring one thing into view: the first selector that matches an element. A prose result
 * falls back from its block to its owner until the block is in the page.
 */
export const ScrollTarget = Schema.Struct({
  block: Schema.Literals(["nearest", "start"]),
  selectors: Schema.Array(Schema.String),
});
export type ScrollTarget = typeof ScrollTarget.Type;

const headingSelector = (id: string): string => `[data-prd-pane] [data-section="${id}"]`;

const targetOf = (
  block: ScrollTarget["block"],
  selectors: ReadonlyArray<string>,
): ScrollTarget => ({
  block,
  selectors,
});

const blockSelectorOf = (result: SearchResult): ReadonlyArray<string> =>
  Array.map(Array.fromOption(blockKeyOf(result)), (key) => `[data-block="${key}"]`);

/**
 * What holds a task in the stacks pane: its chip, or the segment of the trunk it is folded into,
 * whichever comes first in the page.
 */
export const stackTaskSelectorOf = (id: string): string =>
  `[data-stacks-pane] [data-task="${id}"], [data-stacks-pane] [data-holds~="${id}"]`;

/**
 * What a selected result brings into view in the reader. A PRD section scrolls the PRD pane to its
 * heading, or to its matched block. A spec section scrolls its card, or its matched block, in the
 * spec pane. A task scrolls its row in the spec pane and its chip in the stacks pane. The first
 * row of a task is the one in the earliest card, and a task listed as a stray has `_` for a spec.
 */
export const targetsOf = (result: SearchResult): ReadonlyArray<ScrollTarget> =>
  Node.match(result.node, {
    section: ({ id }) =>
      isPrdSection(id)
        ? [
            Array.isReadonlyArrayEmpty(blockSelectorOf(result))
              ? targetOf("start", [headingSelector(id)])
              : targetOf("nearest", Array.append(blockSelectorOf(result), headingSelector(id))),
          ]
        : [targetOf("nearest", Array.append(blockSelectorOf(result), `[data-spec="${id}"]`))],
    task: ({ id }) => [
      targetOf("nearest", [`[data-task-row$=":${id}"]`]),
      targetOf("nearest", [stackTaskSelectorOf(id)]),
    ],
  });

/** A PRD section and where its heading's top edge is. */
export interface SectionTop {
  readonly id: PrdSectionId;
  readonly top: number;
}

/**
 * The section at the top of the pane: the last one whose top is at or above `line`, or the first
 * when none is. `tops` is in document order and leaves out the level 1 title. None for no sections.
 */
export const sectionAtTop = (
  tops: ReadonlyArray<SectionTop>,
  line: number,
): Option.Option<PrdSectionId> =>
  Array.findLast(tops, (section) => section.top <= line).pipe(
    Option.orElse(() => Array.head(tops)),
    Option.map((section) => section.id),
  );

/** What decides whether a spec card is open: the density, and the cards opened or closed on their own. */
export interface Disclosed {
  readonly density: Density;
  readonly opened: Record.ReadonlyRecord<string, boolean>;
}

/** A card is open when it was opened or closed on its own, and else when the density is `full`. */
export const isOpenCard = (disclosed: Disclosed, id: SectionId): boolean =>
  Option.getOrElse(Record.get(disclosed.opened, id), () => disclosed.density === "full");

/** What decides whether a PRD section's prose shows: the condensed switch, and the sections opened or closed on their own. */
export interface Folded {
  readonly isPrdCondensed: boolean;
  readonly prdOpened: Record.ReadonlyRecord<string, boolean>;
}

/** A PRD section is open when it was opened or closed on its own, and else when the PRD is not condensed. */
export const isOpenPrdSection = (folded: Folded, id: SectionId): boolean =>
  Option.getOrElse(Record.get(folded.prdOpened, id), () => !folded.isPrdCondensed);

/** A spec section and the tasks that name it. */
export interface Card {
  readonly section: TraceSection;
  readonly tasks: ReadonlyArray<TraceTask>;
}

export interface Cards {
  readonly cards: ReadonlyArray<Card>;
  /** Tasks in the chain that no card lists: they name the PRD section, not a spec section that implements it. */
  readonly strays: ReadonlyArray<TraceTask>;
}

/** The tasks that name the spec section, in manifest order. */
export const tasksOf = (trace: Trace, section: TraceSection): ReadonlyArray<TraceTask> =>
  Array.filter(trace.tasks, (task) =>
    Array.some(task.specSections, (id) => String.Equivalence(id, section.id)),
  );

const chainFor = (trace: Trace, prd: PrdSectionId) =>
  chainOf(trace, { id: SectionId.make(prd), kind: "section" });

/**
 * The spec sections in the PRD section's chain, in document order, each with the tasks whose
 * `specSections` name it, in manifest order; and the strays.
 */
export const cardsOf = (trace: Trace, prd: PrdSectionId): Cards => {
  const chain = chainFor(trace, prd);
  const cards = Array.map(
    Array.filter(trace.spec.sections, (section) => HashSet.has(chain.spec, section.id)),
    (section) => ({ section, tasks: tasksOf(trace, section) }),
  );
  const strays = Array.filter(
    trace.tasks,
    (task) =>
      HashSet.has(chain.tasks, task.id) &&
      !Array.some(cards, (card) => Array.some(card.tasks, (listed) => listed.id === task.id)),
  );
  return { cards, strays };
};

export interface Counts {
  readonly specs: number;
  readonly tasks: number;
  readonly done: number;
}

const isDone = (task: TraceTask): boolean => task.status === "done" || task.status === "landed";

const countOf = (specs: number, tasks: ReadonlyArray<TraceTask>): Counts => ({
  done: Array.length(Array.filter(tasks, isDone)),
  specs,
  tasks: Array.length(tasks),
});

/** How many spec sections and tasks are in the PRD section's chain, and how many tasks are done or landed. */
export const countsOf = (trace: Trace, prd: PrdSectionId): Counts => {
  const chain = chainFor(trace, prd);
  return countOf(
    HashSet.size(chain.spec),
    Array.filter(trace.tasks, (task) => HashSet.has(chain.tasks, task.id)),
  );
};

/** An item and the spec sections that implement it. */
export interface ItemSpecs {
  readonly id: PrdSectionId;
  readonly specs: ReadonlyArray<string>;
}

/** The items under a PRD section, each with the spec sections that implement it; none for an item. */
export const itemSpecsOf = (trace: Trace, prd: PrdSectionId): ReadonlyArray<ItemSpecs> =>
  Array.flatMap(trace.prd.items, (item) =>
    isPrdSection(item.id) && String.Equivalence(item.section, prd)
      ? [{ id: item.id, specs: Array.fromIterable(chainFor(trace, item.id).spec) }]
      : [],
  );

/** The IDs of the tasks in the current section's chain; none when there is no current section. */
export const currentTasksOf = (
  trace: Trace,
  maybeCurrent: Option.Option<PrdSectionId>,
): HashSet.HashSet<string> =>
  Option.match(maybeCurrent, {
    onNone: () => HashSet.empty<string>(),
    onSome: (prd) => chainFor(trace, prd).tasks,
  });

/** The same count over every spec section and task of the plan. */
export const planCountsOf = (trace: Trace): Counts =>
  countOf(Array.length(trace.spec.sections), trace.tasks);

/** The note for a section the spec does not build, and none for any other status. */
export const coverageOf = (status: SectionStatus): Option.Option<string> =>
  Match.value(status).pipe(
    Match.when("deferred", () => Option.some("Deferred: the spec leaves this for later.")),
    Match.when("context", () => Option.some("Context: the spec treats this as needing no code.")),
    Match.when("unmapped", () =>
      Option.some("Unmapped: no spec section covers this; `cairn lint` reports it."),
    ),
    Match.orElse(() => Option.none()),
  );

/** The word shown for a status: `in progress`, `not started` and `waiting on a human`, and the status otherwise. */
export const statusWordOf = (status: SectionStatus): string =>
  Match.value(status).pipe(
    Match.when("in_progress", () => "in progress"),
    Match.when("pending", () => "not started"),
    Match.when("blocked_on_human", () => "waiting on a human"),
    Match.orElse((other) => other),
  );

export interface Ran {
  readonly model: string;
  readonly reasoning: Reasoning;
  readonly ran: boolean;
}

/**
 * What the task ran on. When a `running` event carries both a model and a reasoning, the latest
 * such event's pair, with `ran: true`. Otherwise the manifest's pair, planned, with `ran: false`.
 */
export const ranOf = (task: TraceTask): Ran =>
  pipe(
    Array.getSomes(
      Array.map(task.events, (event) =>
        event.status === "running" && event.model !== undefined && event.reasoning !== undefined
          ? Option.some({ model: event.model, reasoning: event.reasoning, ts: event.ts })
          : Option.none(),
      ),
    ),
    Array.match({
      onEmpty: (): Ran => ({ model: task.model, ran: false, reasoning: task.reasoning }),
      onNonEmpty: (found): Ran => {
        const latest = Array.max(
          found,
          Order.mapInput(DateTime.Order, (each: (typeof found)[number]) => each.ts),
        );
        return { model: latest.model, ran: true, reasoning: latest.reasoning };
      },
    }),
  );
