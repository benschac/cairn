import { UiStruct } from "@effect/ui";
import { PrdSectionId, SectionId, TaskId, type TaskStatus, type Trace } from "@cairn/contract";
import { indexOf } from "@cairn/core/relation-index";
import { sectionLinksOf } from "@cairn/core/section-links";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Record, Struct } from "effect";

import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen, TraceData, type Model } from "../src/model.ts";
import { linksFor } from "../src/reader.ts";
import { chainOf, type Node } from "../src/trace.ts";
import { ScrollPrdSection, update } from "../src/update.ts";
import {
  attr,
  both,
  containing,
  data,
  detailDividerRunning,
  focusedHeading,
  inside,
  loaded,
  notContaining,
  pushedUrl,
  readerMounted,
  resolved,
  tag,
  unfolded,
  viewerScene,
} from "./fixtures.ts";

const prd = (id: string) => PrdSectionId.make(id);
const taskId = (id: string) => TaskId.make(id);

const FUZZY = "prd.viewer.fuzzy-search";
const TASK_DETAIL = "prd.viewer.task-detail";
const DEPENDENCIES = "prd.viewer.dependencies";
const LINT = "prd.cli.lint";

/** The trace with these tasks' statuses, and what the trace carries about starting recomputed from the index. */
const withStatuses = (statuses: Record.ReadonlyRecord<string, TaskStatus>): Trace => {
  const statusOf = (id: TaskId): TaskStatus =>
    Option.getOrElse(Record.get(statuses, id), () =>
      Option.match(
        Array.findFirst(demoTrace.tasks, (task) => task.id === id),
        { onNone: (): TaskStatus => "pending", onSome: (task) => task.status },
      ),
    );
  const index = indexOf({ trace: demoTrace });
  return Struct.evolve(demoTrace, {
    tasks: Array.map((task) =>
      Struct.assign(task, {
        canStart: index.canStart(task.id, statusOf),
        status: statusOf(task.id),
        waitedOnBy: index.waitedOnBy(task.id, statusOf),
        waitsOn: index.waitsOn(task.id, statusOf),
      }),
    ),
  });
};

const readingOf = (trace: Trace): Model =>
  unfolded(
    UiStruct.evolve(loaded, {
      screen: () => Screen.Reader(),
      trace: () => TraceData.Success({ data: trace }),
    }),
  );

const reading = readingOf(demoTrace);

/** The tasks the dependencies section waits on, which the fixtures set to unfinished and to done. */
const WAITED_ON = ["t139", "t140", "t165"];
const OWN = "t168";
const waiting = withStatuses(
  Record.fromIterableWith(Array.prepend(WAITED_ON, OWN), (id) => [id, "pending" as const]),
);
const released = withStatuses(
  Record.fromIterableWith(Array.prepend(WAITED_ON, OWN), (id) => [
    id,
    id === OWN ? ("pending" as const) : ("done" as const),
  ]),
);

const linksButton = (id: string) => data("links-button", id);
const list = (id: string) => data("links", id);
const group = (owner: string, name: string) => inside(list(owner), data("links-group", name));
const entry = (owner: string, name: string, id: string) =>
  inside(group(owner, name), data("link", id));
const nextTask = (owner: string, id: string) => inside(group(owner, "next"), data("link-task", id));
const statusLine = (id: string) => data("status-line", id);
const tagButton = tag("button");
const chip = (id: string) => inside(data("stacks-pane"), data("task", id));

/** What a section's links part reads, from the links the core answers. */
const linksText = (trace: Trace, id: string): string => {
  const links = sectionLinksOf(
    indexOf({ trace }),
    { items: trace.prd.items, sections: trace.prd.sections, spec: trace.spec.sections },
    prd(id),
    {
      statusOf: (task) =>
        Option.match(
          Array.findFirst(trace.tasks, (each) => each.id === task),
          { onNone: (): TaskStatus => "pending", onSome: (each) => each.status },
        ),
    },
  );
  const base = `needs ${Array.length(links.needs)} · needed by ${Array.length(links.neededBy)}`;
  return Array.isReadonlyArrayEmpty(links.next)
    ? base
    : `${base} · ${links.ready === 0 ? "waiting" : `${links.ready} ready`}`;
};

const taskNode = (id: string): Node => ({ id: taskId(id), kind: "task" });

it("the demo trace has the links the scenes read", () => {
  const needs = linksFor(demoTrace, prd(FUZZY), false).needs;
  const found = Option.getOrThrow(Array.findFirst(needs, (link) => link.id === TASK_DETAIL));
  assert(found.pairs).toContainEqual({ needs: "t94", task: "t95" });
  const back = linksFor(demoTrace, prd(TASK_DETAIL), false).neededBy;
  assert(Array.some(back, (link) => link.id === FUZZY)).toBe(true);
});

it.effect(
  "opening the links of Fuzzy search lists Task detail under Needs with t95 needs t94, and Task detail's lists Fuzzy search under Needed by (prd.viewer.dependencies#v1)",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .expect(linksButton(FUZZY))
        .toHaveText(linksText(demoTrace, FUZZY))
        .expect(linksButton(FUZZY))
        .toHaveAttribute("aria-expanded", "false")
        .expect(list(FUZZY))
        .toHaveCount(0)
        .click(linksButton(FUZZY))
        .expect(linksButton(FUZZY))
        .toHaveAttribute("aria-expanded", "true")
        .expect(entry(FUZZY, "needs", TASK_DETAIL))
        .toHaveText(containing("Task detail"))
        .expect(entry(FUZZY, "needs", TASK_DETAIL))
        .toHaveText(containing("t95 needs t94"))
        .expect(entry(FUZZY, "needed-by", TASK_DETAIL))
        .toHaveCount(0)
        .click(linksButton(TASK_DETAIL))
        .expect(list(FUZZY))
        .toHaveCount(0)
        .expect(entry(TASK_DETAIL, "needed-by", FUZZY))
        .toHaveText(containing("Fuzzy search"))
        .expect(entry(TASK_DETAIL, "needed-by", FUZZY))
        .toHaveText(containing("t95 needs t94"))
        .expect(entry(TASK_DETAIL, "needs", FUZZY))
        .toHaveCount(0);
    }),
);

it.effect(
  "a section whose unfinished tasks all wait on another section's says waiting and names them in Next, and says 1 ready once they are done (prd.viewer.dependencies#v2)",
  () =>
    Effect.gen(function* () {
      const before = yield* viewerScene(readingOf(waiting));
      before
        .pipe(readerMounted)
        .expect(linksButton(DEPENDENCIES))
        .toHaveText(containing("waiting"))
        .expect(linksButton(DEPENDENCIES))
        .toHaveText(notContaining("ready"))
        .click(linksButton(DEPENDENCIES))
        .expect(inside(group(DEPENDENCIES, "next"), data("link-task")))
        .toHaveCount(1)
        .expect(nextTask(DEPENDENCIES, OWN))
        .toHaveAttribute("data-can-start", "false")
        .expect(nextTask(DEPENDENCIES, OWN))
        .toHaveText(containing(`waits on ${Array.join(WAITED_ON, ", ")}`));
      assert(linksText(waiting, DEPENDENCIES)).toContain("waiting");

      const after = yield* viewerScene(readingOf(released));
      assert(linksText(released, DEPENDENCIES)).toContain("1 ready");
      after
        .pipe(readerMounted)
        .expect(linksButton(DEPENDENCIES))
        .toHaveText(containing("1 ready"))
        .expect(linksButton(DEPENDENCIES))
        .toHaveText(notContaining("waiting"))
        .click(linksButton(DEPENDENCIES))
        .expect(nextTask(DEPENDENCIES, OWN))
        .toHaveAttribute("data-can-start", "true")
        .expect(inside(nextTask(DEPENDENCIES, OWN), data("link-waits")))
        .toHaveCount(0);
    }),
);

it.effect(
  "an item's annotation ends with its own links button, and opening it lists under the item",
  () =>
    Effect.gen(function* () {
      const item = inside(data("prd-pane"), data("item", LINT));
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .expect(inside(item, linksButton(LINT)))
        .toHaveText(linksText(demoTrace, LINT))
        .expect(inside(item, data("links")))
        .toHaveCount(0)
        .click(linksButton(LINT))
        .expect(inside(item, data("links", LINT)))
        .toHaveCount(1)
        .expect(inside(item, data("item-annotation", LINT)))
        .toHaveAttribute("aria-pressed", "false")
        .click(linksButton(LINT))
        .expect(inside(item, data("links")))
        .toHaveCount(0);
    }),
);

it.effect("opening a list leaves the pin as it was; the button again, or Escape, closes it", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(statusLine(FUZZY))
      .pipe(pushedUrl)
      .expect(statusLine(FUZZY))
      .toHaveAttribute("aria-pressed", "true")
      .click(linksButton(TASK_DETAIL))
      .expect(list(TASK_DETAIL))
      .toHaveCount(1)
      .expect(statusLine(FUZZY))
      .toHaveAttribute("aria-pressed", "true")
      .expect(statusLine(TASK_DETAIL))
      .toHaveAttribute("aria-pressed", "false")
      .click(linksButton(TASK_DETAIL))
      .expect(list(TASK_DETAIL))
      .toHaveCount(0)
      .click(linksButton(TASK_DETAIL))
      .expect(list(TASK_DETAIL))
      .toHaveCount(1)
      .fireDocument("keydown", { key: "Escape" })
      .expect(list(TASK_DETAIL))
      .toHaveCount(0)
      .expect(statusLine(FUZZY))
      .toHaveAttribute("aria-pressed", "true")
      .fireDocument("keydown", { key: "Escape" })
      .pipe(pushedUrl)
      .expect(statusLine(FUZZY))
      .toHaveAttribute("aria-pressed", "false");
  }),
);

it("opening a list pins nothing and closes the one before; the model keeps one open", () => {
  const opened = update(reading, Message.ClickedLinks({ id: prd(FUZZY) })).model;
  assert(opened.reader.maybePinned).toStrictEqual(Option.none());
  assert(opened.reader.maybeLinksOpen).toStrictEqual(Option.some(prd(FUZZY)));
  const moved = update(opened, Message.ClickedLinks({ id: prd(TASK_DETAIL) })).model;
  assert(moved.reader.maybeLinksOpen).toStrictEqual(Option.some(prd(TASK_DETAIL)));
  const closed = update(moved, Message.ClickedLinks({ id: prd(TASK_DETAIL) })).model;
  assert(closed.reader.maybeLinksOpen).toStrictEqual(Option.none());
});

it("Escape goes back from an open panel first, then closes the list, then clears the pin", () => {
  const pinned = update(reading, Message.ClickedStatusLine({ id: prd(FUZZY) })).model;
  const listed = update(pinned, Message.ClickedLinks({ id: prd(TASK_DETAIL) })).model;
  const withPanel = UiStruct.evolve(listed, { detail: () => [taskNode("t95")] });
  const first = update(withPanel, Message.PressedEscape()).model;
  assert(first.detail).toStrictEqual([]);
  assert(first.reader.maybeLinksOpen).toStrictEqual(Option.some(prd(TASK_DETAIL)));
  assert(first.reader.maybePinned).toStrictEqual(Option.some(prd(FUZZY)));
  const second = update(first, Message.PressedEscape()).model;
  assert(second.reader.maybeLinksOpen).toStrictEqual(Option.none());
  assert(second.reader.maybePinned).toStrictEqual(Option.some(prd(FUZZY)));
  const third = update(second, Message.PressedEscape()).model;
  assert(third.reader.maybePinned).toStrictEqual(Option.none());
});

it.effect("the switch shows everything before and after, each with the link it comes through", () =>
  Effect.gen(function* () {
    const direct = linksFor(demoTrace, prd(FUZZY), false);
    const all = linksFor(demoTrace, prd(FUZZY), true);
    const reached = Array.filter(Array.appendAll(all.needs, all.neededBy), (link) =>
      Option.isSome(link.via),
    );
    assert(Array.length(all.needs)).toBeGreaterThan(Array.length(direct.needs));
    assert(Array.length(reached)).toBeGreaterThan(0);
    const farther = Option.getOrThrow(
      Array.head(Array.filter(all.needs, (link) => Option.isSome(link.via))),
    );
    const switchOf = inside(list(FUZZY), attr("role", "switch"));
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(linksButton(FUZZY))
      .expect(switchOf)
      .toHaveText("Everything before and after")
      .expect(switchOf)
      .toHaveAttribute("aria-checked", "false")
      .expect(inside(list(FUZZY), data("link-via")))
      .toHaveCount(0)
      .expect(entry(FUZZY, "needs", farther.id))
      .toHaveCount(0)
      .expect(inside(group(FUZZY, "needs"), data("link")))
      .toHaveCount(Array.length(direct.needs))
      .click(switchOf)
      .expect(switchOf)
      .toHaveAttribute("aria-checked", "true")
      .expect(inside(group(FUZZY, "needs"), data("link")))
      .toHaveCount(Array.length(all.needs))
      .expect(inside(group(FUZZY, "needed-by"), data("link")))
      .toHaveCount(Array.length(all.neededBy))
      .expect(inside(list(FUZZY), data("link-via")))
      .toHaveCount(Array.length(reached))
      .expect(entry(FUZZY, "needs", farther.id))
      .toHaveText(containing("via "))
      .click(switchOf)
      .expect(inside(list(FUZZY), data("link-via")))
      .toHaveCount(0);
  }),
);

it.effect("a section entry scrolls the PRD to it and marks it; a task entry opens its detail", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(readingOf(waiting));
    s.pipe(readerMounted)
      .click(linksButton(DEPENDENCIES))
      .expect(inside(data("prd-pane"), both(data("section", "prd.viewer.items"), data("marked"))))
      .toHaveCount(0)
      .click(inside(entry(DEPENDENCIES, "needs", "prd.viewer.items"), data("link-section")))
      .pipe(resolved(ScrollPrdSection, Message.CompletedScrollPrdSection()))
      .expect(inside(data("prd-pane"), both(data("section", "prd.viewer.items"), data("marked"))))
      .toHaveCount(1)
      .expect(list(DEPENDENCIES))
      .toHaveCount(1)
      .click(inside(nextTask(DEPENDENCIES, OWN), tagButton))
      .pipe(pushedUrl, focusedHeading, detailDividerRunning)
      .expect(data("detail"))
      .toHaveAttribute("data-detail-id", OWN);
  }),
);

it.effect("hovering an entry lights its tasks in the stacks and dims the others", () =>
  Effect.gen(function* () {
    const entryButton = inside(entry(FUZZY, "needs", TASK_DETAIL), data("link-section"));
    const lit = Array.fromIterable(
      chainOf(demoTrace, { id: SectionId.make(TASK_DETAIL), kind: "section" }).tasks,
    );
    const inChain = Option.getOrThrow(Array.head(lit));
    const outside = Option.getOrThrow(
      Array.findFirst(demoTrace.tasks, (each) => !Array.contains(lit, each.id)),
    ).id;
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(linksButton(FUZZY))
      .expect(chip(outside))
      .toHaveAttribute("data-dimmed", false)
      .fire(entryButton, "mouseenter")
      .expect(chip(outside))
      .toHaveAttribute("data-dimmed", "")
      .expect(chip(inChain))
      .toHaveAttribute("data-dimmed", false)
      .fire(entryButton, "mouseleave")
      .expect(chip(outside))
      .toHaveAttribute("data-dimmed", false);
  }),
);

const panelOf = (trace: Trace, id: string) =>
  viewerScene(UiStruct.evolve(readingOf(trace), { detail: () => [taskNode(id)] }));

it.effect("the detail panel lists every task that needs the task, finished or not", () =>
  Effect.gen(function* () {
    const needing = Array.filter(demoTrace.tasks, (each) =>
      Array.contains(each.dependsOn, taskId("t95")),
    );
    assert(Array.length(needing)).toBeGreaterThan(0);
    const s = yield* panelOf(demoTrace, "t95");
    s.pipe(readerMounted, detailDividerRunning)
      .expect(data("detail-needed-by"))
      .toHaveText(containing("Needed by"));
    Array.forEach(needing, (each) =>
      s
        .expect(inside(data("detail-needed-by"), data("detail-add", `task:${each.id}`)))
        .toHaveCount(1),
    );
    // A task that is done has nothing to start.
    s.expect(data("detail-starts")).toHaveCount(0);
  }),
);

it.effect(
  "the detail panel says Waits on t139, t140, t165 for a pending task, then Can start now",
  () =>
    Effect.gen(function* () {
      const blocked = yield* panelOf(waiting, OWN);
      blocked
        .pipe(readerMounted, detailDividerRunning)
        .expect(data("detail-starts"))
        .toHaveText(`Waits on ${Array.join(WAITED_ON, ", ")}`)
        .expect(inside(data("detail-starts"), tagButton))
        .toHaveCount(Array.length(WAITED_ON))
        .expect(data("detail-needed-by"))
        .toHaveCount(0);
      const free = yield* panelOf(released, OWN);
      free
        .pipe(readerMounted, detailDividerRunning)
        .expect(data("detail-starts"))
        .toHaveText("Can start now");
    }),
);
