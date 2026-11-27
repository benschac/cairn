import { Event, PrdSectionId, SectionId, TaskId, Trace, type SectionStatus } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, DateTime, HashSet, Option, Schema, Struct } from "effect";

import { demoTrace } from "../src/demo.ts";
import {
  cardsOf,
  countsOf,
  coverageOf,
  currentOf,
  planCountsOf,
  ranOf,
  sectionAtTop,
  statusWordOf,
} from "../src/reader.ts";
import { chainOf, itemsOfTask, markedItemsOf } from "../src/trace.ts";

const prd = (n: number): PrdSectionId => PrdSectionId.make(`prd.p${n}`);

const Offsets = Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 0 })));
const Line = Schema.Int.check(Schema.isBetween({ maximum: 300, minimum: -50 }));

/** Tops in document order: the offsets, summed, so they never go backwards. */
const topsOf = (offsets: ReadonlyArray<number>) =>
  Array.map(
    Array.drop(
      Array.scan(offsets, 0, (sum, next) => sum + next),
      1,
    ),
    (top, index) => ({ id: prd(index), top }),
  );

it.prop(
  "sectionAtTop returns the last section at or above the line, or the first when none is",
  [Offsets, Line],
  ([offsets, line]) => {
    const tops = topsOf(offsets);
    const found = sectionAtTop(tops, line);
    const above = Array.filter(tops, (section) => section.top <= line);
    expect(found).toEqual(
      Array.match(tops, {
        onEmpty: () => Option.none(),
        onNonEmpty: (all) =>
          Option.some(
            Array.match(above, {
              onEmpty: () => Array.headNonEmpty(all).id,
              onNonEmpty: (some) => Array.lastNonEmpty(some).id,
            }),
          ),
      }),
    );
  },
);

it.prop(
  "sectionAtTop never moves backwards as the line moves down",
  [Offsets, Line, Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 0 }))],
  ([offsets, line, down]) => {
    const tops = topsOf(offsets);
    const indexOf = (line_: number) =>
      Option.getOrElse(
        Option.flatMap(sectionAtTop(tops, line_), (id) =>
          Array.findFirstIndex(tops, (section) => section.id === id),
        ),
        () => -1,
      );
    expect(indexOf(line + down)).toBeGreaterThanOrEqual(indexOf(line));
  },
);

it("sectionAtTop counts a section whose top is exactly on the line", () => {
  const tops = topsOf([10, 10, 10]);
  expect(sectionAtTop(tops, 20)).toEqual(Option.some(prd(1)));
  expect(sectionAtTop(tops, 5)).toEqual(Option.some(prd(0)));
  expect(sectionAtTop([], 5)).toEqual(Option.none());
});

it("currentOf prefers the search result, then the pin, then the top", () => {
  const reader = { maybeAtTop: Option.some(prd(1)), maybePinned: Option.some(prd(2)) };
  expect(currentOf(reader, Option.some(prd(3)))).toEqual(Option.some(prd(3)));
  expect(currentOf(reader, Option.none())).toEqual(Option.some(prd(2)));
  expect(currentOf({ ...reader, maybePinned: Option.none() }, Option.none())).toEqual(
    Option.some(prd(1)),
  );
  expect(
    currentOf({ maybeAtTop: Option.none(), maybePinned: Option.none() }, Option.none()),
  ).toEqual(Option.none());
});

const prdIds = Array.getSomes(
  Array.map(demoTrace.prd.sections, (section) => Schema.decodeOption(PrdSectionId)(section.id)),
);

it.prop(
  "cardsOf and its strays list every task of the chain, and no stray is in a card",
  [Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 0 }))],
  ([seed]) => {
    const id = Option.getOrThrow(Array.get(prdIds, seed % Array.length(prdIds)));
    const { cards, strays } = cardsOf(demoTrace, id);
    const chain = chainOf(demoTrace, { id: SectionId.make(id), kind: "section" });
    const listed = Array.map(
      Array.flatMap(cards, (card) => card.tasks),
      (task) => task.id,
    );
    const strayIds = Array.map(strays, (task) => task.id);
    expect(HashSet.fromIterable(Array.appendAll(listed, strayIds))).toEqual(chain.tasks);
    expect(Array.some(strayIds, (stray) => Array.contains(listed, stray))).toBe(false);
    expect(Array.map(cards, (card) => card.section.id)).toEqual(
      Array.filter(
        Array.map(demoTrace.spec.sections, (section) => section.id),
        (sectionId) => HashSet.has(chain.spec, sectionId),
      ),
    );
  },
);

it.prop(
  "a count's done never passes its total",
  [Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 0 }))],
  ([seed]) => {
    const id = Option.getOrThrow(Array.get(prdIds, seed % Array.length(prdIds)));
    const counts = countsOf(demoTrace, id);
    expect(counts.done).toBeLessThanOrEqual(counts.tasks);
    const plan = planCountsOf(demoTrace);
    expect(plan.done).toBeLessThanOrEqual(plan.tasks);
    expect(plan.tasks).toBe(Array.length(demoTrace.tasks));
    expect(plan.tasks).toBeGreaterThanOrEqual(counts.tasks);
  },
);

it("a stray is a task that names the PRD section but no spec section that implements it", () => {
  const base = Schema.encodeSync(Trace)(demoTrace);
  const first = Option.getOrThrow(Array.head(base.tasks));
  const id = PrdSectionId.make("prd.viewer");
  const stray = { ...first, id: "t9999", prdSections: [id], specSections: ["spec.nowhere"] };
  const trace = Schema.decodeUnknownSync(Trace)({
    ...base,
    tasks: Array.append(base.tasks, stray),
  });
  const { strays } = cardsOf(trace, id);
  expect(Array.map(strays, (task) => task.id)).toEqual(["t9999"]);
});

const statuses: ReadonlyArray<SectionStatus> = [
  "deferred",
  "context",
  "unmapped",
  "blocked_on_human",
  "failed",
  "running",
  "landed",
  "done",
  "pending",
  "in_progress",
];

it("a note comes only for a deferred, context or unmapped section", () => {
  Array.forEach(statuses, (status) => {
    expect(Option.isSome(coverageOf(status))).toBe(
      Array.contains(["deferred", "context", "unmapped"], status),
    );
  });
});

it("a status word is the status except for three", () => {
  expect(statusWordOf("in_progress")).toBe("in progress");
  expect(statusWordOf("pending")).toBe("not started");
  expect(statusWordOf("blocked_on_human")).toBe("waiting on a human");
  expect(statusWordOf("done")).toBe("done");
  expect(statusWordOf("deferred")).toBe("deferred");
});

const baseTask = Option.getOrThrow(Array.head(demoTrace.tasks));

const eventOf = (index: number, fields: object) =>
  Schema.decodeUnknownSync(Event)({
    taskId: baseTask.id,
    ts: DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, index))),
    ...fields,
  });

const Models = Schema.Literals(["opus", "sonnet", "haiku", "other"]);
const Levels = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
const Pair = Schema.Struct({ model: Models, reasoning: Levels });

/** A running event that lacks a model or a reasoning, or an event that is not running. */
const Unrecorded = Schema.Union([
  Schema.Struct({ status: Schema.Literal("running"), model: Models }),
  Schema.Struct({ status: Schema.Literal("running"), reasoning: Levels }),
  Schema.Struct({ status: Schema.Literal("running") }),
  Schema.Struct({ status: Schema.Literal("done"), model: Models, reasoning: Levels }),
  Schema.Struct({ status: Schema.Literal("failed"), model: Models, reasoning: Levels }),
]);

it.prop(
  "ranOf returns the manifest's pair and ran: false when no running event names both",
  [Schema.Array(Unrecorded)],
  ([unrecorded]) => {
    const task = {
      ...baseTask,
      events: Array.map(unrecorded, (fields, index) => eventOf(index, fields)),
    };
    expect(ranOf(task)).toEqual({
      model: baseTask.model,
      ran: false,
      reasoning: baseTask.reasoning,
    });
  },
);

it.prop(
  "ranOf returns the latest recorded pair and ran: true, wherever it sits in the list",
  [Schema.NonEmptyArray(Pair), Schema.Array(Unrecorded), Schema.Boolean],
  ([pairs, unrecorded, isReversed]) => {
    const fields = Array.appendAll(
      Array.map(pairs, (pair) => ({ ...pair, status: "running" })),
      unrecorded,
    );
    const stamped = Array.map(fields, (each, index) => ({ each, index }));
    const events = Array.map(stamped, ({ each, index }) =>
      eventOf(isReversed ? Array.length(fields) - index : index, each),
    );
    const expected = isReversed ? Array.headNonEmpty(pairs) : Array.lastNonEmpty(pairs);
    expect(ranOf({ ...baseTask, events })).toEqual({
      model: expected.model,
      ran: true,
      reasoning: expected.reasoning,
    });
  },
);

it("the demo trace has a task that ran and one that did not", () => {
  const ran = Array.map(demoTrace.tasks, (each) => ranOf(each).ran);
  expect(Array.contains(ran, true)).toBe(true);
  expect(Array.contains(ran, false)).toBe(true);
});

// --- List items ---

const itemIds = Array.map(demoTrace.prd.items, (item) => item.id);

it("the demo trace has list items with IDs", () => {
  expect(Array.length(demoTrace.prd.items)).toBeGreaterThan(1);
});

it.prop(
  "an item's counts never pass its section's counts",
  [Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 0 }))],
  ([seed]) => {
    const item = Option.getOrThrow(Array.get(demoTrace.prd.items, seed % Array.length(itemIds)));
    const own = countsOf(demoTrace, Schema.decodeSync(PrdSectionId)(item.id));
    const section = countsOf(demoTrace, Schema.decodeSync(PrdSectionId)(item.section));
    expect(own.specs).toBeLessThanOrEqual(section.specs);
    expect(own.tasks).toBeLessThanOrEqual(section.tasks);
    expect(own.done).toBeLessThanOrEqual(section.done);
  },
);

it.prop(
  "an item's chain is inside its section's chain, and holds the item",
  [Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 0 }))],
  ([seed]) => {
    const item = Option.getOrThrow(Array.get(demoTrace.prd.items, seed % Array.length(itemIds)));
    const own = chainOf(demoTrace, { id: item.id, kind: "section" });
    const section = chainOf(demoTrace, { id: item.section, kind: "section" });
    expect(HashSet.has(own.prd, item.id)).toBe(true);
    expect(Array.every(Array.fromIterable(own.spec), (id) => HashSet.has(section.spec, id))).toBe(
      true,
    );
    expect(Array.every(Array.fromIterable(own.tasks), (id) => HashSet.has(section.tasks, id))).toBe(
      true,
    );
  },
);

/** The demo trace with `spec.lint` implementing only the item, not the section above it. */
const onlyTheItem: typeof demoTrace = Struct.evolve(demoTrace, {
  spec: (spec) =>
    Struct.evolve(spec, {
      sections: Array.map((section) =>
        section.id === "spec.lint"
          ? Struct.evolve(section, {
              keys: (keys) =>
                Struct.evolve(keys, { implements: () => [PrdSectionId.make("prd.cli.lint")] }),
            })
          : section,
      ),
    }),
});

it("a section's chain holds the chains of its items, so its counts and cards include them", () => {
  const cli = SectionId.make("prd.cli");
  const without = chainOf(
    Struct.evolve(onlyTheItem, { prd: (document) => Struct.evolve(document, { items: () => [] }) }),
    { id: cli, kind: "section" },
  );
  const within = chainOf(onlyTheItem, { id: cli, kind: "section" });
  expect(HashSet.has(without.spec, "spec.lint")).toBe(false);
  expect(HashSet.has(within.spec, "spec.lint")).toBe(true);
  expect(countsOf(onlyTheItem, PrdSectionId.make("prd.cli")).specs).toBeGreaterThan(
    HashSet.size(without.spec),
  );
  expect(
    Array.some(
      cardsOf(onlyTheItem, PrdSectionId.make("prd.cli")).cards,
      (card) => card.section.id === "spec.lint",
    ),
  ).toBe(true);
});

it("a task's chain lights the items its spec sections implement, and itemsOfTask lists them", () => {
  const task = Option.getOrThrow(Array.findFirst(demoTrace.tasks, (each) => each.id === "t27"));
  const chain = chainOf(demoTrace, { id: task.id, kind: "task" });
  expect(HashSet.has(chain.prd, "prd.cli.lint")).toBe(true);
  expect(HashSet.has(chain.prd, "prd.cli")).toBe(true);
  expect(Array.map(itemsOfTask(demoTrace, task.id), (item) => item.id)).toEqual(["prd.cli.lint"]);
});

it("a task's items are the ones it names and the ones its spec sections' Implements name", () => {
  const heading = Struct.evolve(demoTrace, {
    spec: (spec) =>
      Struct.evolve(spec, {
        sections: Array.map((section) =>
          section.id === "spec.lint"
            ? Struct.evolve(section, {
                keys: (keys) =>
                  Struct.evolve(keys, { implements: () => [PrdSectionId.make("prd.cli")] }),
              })
            : section,
        ),
      }),
  });
  // spec.lint implements only the heading, which does not cover the items under it.
  expect(itemsOfTask(heading, TaskId.make("t27"))).toEqual([]);
  expect(Array.map(itemsOfTask(demoTrace, TaskId.make("t27")), (item) => item.id)).toEqual([
    "prd.cli.lint",
  ]);
  const named = Struct.evolve(heading, {
    tasks: Array.map((task) =>
      task.id === "t27"
        ? Struct.evolve(task, { prdSections: () => Array.make(PrdSectionId.make("prd.cli.init")) })
        : task,
    ),
  });
  expect(Array.map(itemsOfTask(named, TaskId.make("t27")), (item) => item.id)).toEqual([
    "prd.cli.init",
  ]);
  expect(
    markedItemsOf(named, Option.some({ id: TaskId.make("t27"), kind: "task" as const })),
  ).toEqual(["prd.cli.init"]);
  expect(
    markedItemsOf(heading, Option.some({ id: TaskId.make("t27"), kind: "task" as const })),
  ).toEqual([]);
});
