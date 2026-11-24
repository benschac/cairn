import {
  SectionId,
  type PrdSectionId,
  type Reasoning,
  SectionStatus,
  Trace,
  TraceSection,
  TraceTask,
} from "@cairn/contract";
import { Array, DateTime, HashSet, Match, Option, Order, Record, String, pipe } from "effect";

import type { Density } from "./model.ts";
import { chainOf } from "./trace.ts";

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
    (section) => ({
      section,
      tasks: Array.filter(trace.tasks, (task) =>
        Array.some(task.specSections, (id) => String.Equivalence(id, section.id)),
      ),
    }),
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
