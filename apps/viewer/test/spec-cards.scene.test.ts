import { UiStruct } from "@effect/ui";
import { PrdSectionId, SectionId, TaskId, type TraceTask } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Effect, Option, Result, Schema } from "effect";

import { patchPathOf } from "../src/codeView.ts";
import { FetchPatch } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { RenderDiff } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { Screen, TraceData, WHOLE_TASK } from "../src/model.ts";
import { cardsOf, statusWordOf } from "../src/reader.ts";
import { FocusDetailHeading, update } from "../src/update.ts";
import { PressDivider } from "../src/view/dividerView.ts";
import {
  attr,
  attrStartingWith,
  both,
  byRole,
  containing,
  data,
  forEachStep,
  inside,
  loaded,
  prdScrolledTo,
  pushedUrl,
  readerMounted,
  readerMountedAt,
  resolved,
  tag,
  viewerScene,
  type ViewerSteps,
  withClass,
} from "./fixtures.ts";

const prd = (id: string) => PrdSectionId.make(id);

const reading = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });

const statusLine = (id: string) => data("status-line", id);
const card = (id: string) => data("spec", id);
const header = (id: string) => inside(card(id), both(tag("button"), attr("aria-expanded")));
const cards = data("spec");
const rows = inside(data("spec-pane"), data("task-row"));
const summaries = inside(data("spec-pane"), data("summary"));
const fulls = inside(data("spec-pane"), data("full-spec"));
const densityButton = (name: string) => byRole("button", { name });
const groups = inside(data("spec-pane"), attr("role", "group"));

/** The spec sections that implement the section, in the spec's order, as the spec's own keys say. */
const implementing = (id: string) =>
  Array.map(
    Array.filter(demoTrace.spec.sections, (section) =>
      Array.some(section.keys.implements, (each) => each === id),
    ),
    (section) => section.id,
  );

const SECTION = "prd.viewer.spec-cards";
const SPEC = "spec.viewer.spec-cards";

/** The reader pinned to the section, as a click on its status line leaves it. */
const pinned = (id: string) => (s: ViewerSteps) =>
  s.pipe(readerMounted).click(statusLine(id)).pipe(pushedUrl);

it.effect(
  "a pinned section shows a card for each spec section that implements it, in the spec's order",
  () =>
    Effect.gen(function* () {
      const ids = implementing(SECTION);
      assert(Array.length(ids)).toBeGreaterThan(0);
      const s = yield* viewerScene(reading);
      s.pipe(pinned(SECTION))
        .expect(cards)
        .toHaveCount(Array.length(ids))
        .pipe(forEachStep(ids, (step, id) => step.expect(card(id)).toExist()))
        // A card holds its tasks as rows, each named by its spec section and task.
        .expect(inside(card(SPEC), attrStartingWith("data-task-row", `${SPEC}:`)))
        .toExist()
        .expect(groups)
        .toExist();
      assert(
        Array.map(cardsOf(demoTrace, prd(SECTION)).cards, (each) => each.section.id),
      ).toStrictEqual(ids);
    }),
);

it.effect(
  "the label counts the sections and names the PRD section, and a card's header counts its done tasks",
  () =>
    Effect.gen(function* () {
      const { cards: found } = cardsOf(demoTrace, prd("prd.viewer.reader"));
      const first = Option.getOrThrow(Array.head(found));
      const done = Array.length(
        Array.filter(first.tasks, (task) => task.status === "done" || task.status === "landed"),
      );
      const s = yield* viewerScene(reading);
      s.pipe(pinned("prd.viewer.reader"))
        .expect(inside(data("spec-pane"), withClass("label")))
        .toHaveText(`Spec · ${Array.length(found)} sections for Reading the plan`)
        .expect(header(first.section.id))
        .toHaveText(containing(first.section.title))
        .expect(header(first.section.id))
        .toHaveText(containing(`${done}/${Array.length(first.tasks)}`));
    }),
);

it.effect(
  "a task row shows its status, ID, title and the commit count or the status word, and opens the task",
  () =>
    Effect.gen(function* () {
      const task = Option.getOrThrow(
        Array.findFirst(demoTrace.tasks, (each) =>
          Array.some(each.specSections, (id) => id === SPEC),
        ),
      );
      const row = data("task-row", `${SPEC}:${task.id}`);
      const s = yield* viewerScene(reading);
      s.pipe(pinned(SECTION))
        .expect(row)
        .toHaveText(containing(task.id))
        .expect(row)
        .toHaveText(containing(task.title))
        .expect(row)
        .toHaveText(
          containing(
            Array.isReadonlyArrayEmpty(task.commits)
              ? statusWordOf(task.status)
              : `${Array.length(task.commits)} commit`,
          ),
        )
        .click(row)
        .pipe(pushedUrl, resolved(FocusDetailHeading, Message.CompletedFocusDetailHeading()))
        .expectMount(PressDivider({ pane: "detail" }))
        .pipe(
          forEachStep(Option.toArray(patchPathOf(task, WHOLE_TASK)), (step, path) =>
            step
              .pipe(
                resolved(FetchPatch, Message.ReceivedPatch({ path, result: Result.succeed("") })),
              )
              .mounted(RenderDiff, Message.CompletedRenderDiff()),
          ),
        );
      const model = update(reading, Message.ClickedTask({ id: task.id })).model;
      assert(model.detail).toStrictEqual([{ id: task.id, kind: "task" }]);
    }),
);

it.effect.each<{
  statuses: Array<TraceTask["status"]>;
  completed: boolean;
}>([
  { statuses: ["done"], completed: true },
  { statuses: ["landed"], completed: true },
  { statuses: ["done", "landed"], completed: true },
  { statuses: ["done", "pending"], completed: false },
  { statuses: ["done", "running"], completed: false },
  { statuses: ["done", "blocked_on_human"], completed: false },
  { statuses: ["done", "failed"], completed: false },
  { statuses: [], completed: false },
])("marks a spec completed for $statuses: $completed", ({ statuses, completed }) =>
  Effect.gen(function* () {
    const donor = Option.getOrThrow(
      Array.findFirst(demoTrace.tasks, (task) =>
        Array.some(task.specSections, (id) => id === SPEC),
      ),
    );
    const model = UiStruct.evolve(reading, {
      trace: () =>
        TraceData.Success({
          data: {
            ...demoTrace,
            tasks: Array.appendAll(
              Array.filter(
                demoTrace.tasks,
                (task) => !Array.some(task.specSections, (id) => id === SPEC),
              ),
              Array.map(statuses, (status, index) => ({
                ...donor,
                id: TaskId.make(`completion-${index}`),
                status,
              })),
            ),
          },
        }),
    });
    const badge = inside(card(SPEC), withClass("card-completed"));
    const badgeShown = (step: ViewerSteps) =>
      completed ? step.expect(badge).toExist() : step.expect(badge).toBeAbsent();
    const s = yield* viewerScene(model);
    s.pipe(pinned(SECTION))
      .expect(card(SPEC))
      .toHaveAttribute("data-completed", `${completed}`)
      .pipe((step) =>
        completed
          ? step.expect(badge).toHaveText(containing("Completed"))
          : step.expect(badge).toBeAbsent(),
      )
      .click(densityButton("Titles"))
      .pipe(badgeShown)
      .click(densityButton("Full spec"))
      .pipe(badgeShown);
  }),
);

it.effect("the control steps through titles, summaries and full sections while the rows stay", () =>
  Effect.gen(function* () {
    const ids = implementing(SECTION);
    const { cards: found, strays } = cardsOf(demoTrace, prd(SECTION));
    const rowCount =
      Array.length(Array.flatMap(found, (each) => each.tasks)) + Array.length(strays);
    const s = yield* viewerScene(reading);
    s.pipe(pinned(SECTION))
      .expect(densityButton("Summary"))
      .toHaveAttribute("aria-pressed", "true")
      .expect(summaries)
      .toHaveCount(
        Array.length(
          Array.filter(
            demoTrace.spec.sections,
            (section) => Array.contains(ids, section.id) && section.summary !== null,
          ),
        ),
      )
      .expect(fulls)
      .toHaveCount(0)
      .expect(rows)
      .toHaveCount(rowCount)
      .click(densityButton("Titles"))
      .expect(densityButton("Titles"))
      .toHaveAttribute("aria-pressed", "true")
      .expect(densityButton("Summary"))
      .toHaveAttribute("aria-pressed", "false")
      .expect(summaries)
      .toHaveCount(0)
      .expect(fulls)
      .toHaveCount(0)
      .expect(rows)
      .toHaveCount(rowCount)
      .click(densityButton("Full spec"))
      .expect(fulls)
      .toHaveCount(Array.length(ids))
      .expect(summaries)
      .toHaveCount(0)
      .expect(rows)
      .toHaveCount(rowCount)
      // The full section opens with its ID and has the section's own key list as chips.
      .expect(inside(data("full-spec", SPEC), data("key-row", "Implements")))
      .toExist()
      .expect(data("full-spec", SPEC))
      .toHaveText(containing(SPEC))
      .click(densityButton("Summary"))
      .expect(fulls)
      .toHaveCount(0);
  }),
);

it.effect("a card opens and closes alone, and the control resets it", () =>
  Effect.gen(function* () {
    const ids = Array.map(cardsOf(demoTrace, prd("prd.viewer")).cards, (each) => each.section.id);
    const first = Option.getOrThrow(Array.get(ids, 0));
    const second = Option.getOrThrow(Array.get(ids, 1));
    assert(Array.length(ids)).toBeGreaterThan(2);
    const s = yield* viewerScene(reading);
    s.pipe(pinned("prd.viewer"))
      .expect(header(first))
      .toHaveAttribute("aria-expanded", "false")
      .click(header(first))
      .expect(header(first))
      .toHaveAttribute("aria-expanded", "true")
      .expect(data("full-spec", first))
      .toExist()
      .expect(data("summary", first))
      .toBeAbsent()
      // The others are as they were.
      .expect(header(second))
      .toHaveAttribute("aria-expanded", "false")
      .expect(fulls)
      .toHaveCount(1)
      .click(header(first))
      .expect(header(first))
      .toHaveAttribute("aria-expanded", "false")
      .expect(fulls)
      .toHaveCount(0)
      // Open again, then change the control: the card goes back to what the control says.
      .click(header(first))
      .click(densityButton("Titles"))
      .expect(header(first))
      .toHaveAttribute("aria-expanded", "false")
      .expect(fulls)
      .toHaveCount(0)
      // At full density a card can be closed on its own.
      .click(densityButton("Full spec"))
      .click(header(first))
      .expect(header(first))
      .toHaveAttribute("aria-expanded", "false")
      .expect(fulls)
      .toHaveCount(Array.length(ids) - 1);
  }),
);

it.effect("a task that names the section but none of its spec sections is in a last card", () =>
  Effect.gen(function* () {
    const donor = Option.getOrThrow(Array.head(demoTrace.tasks));
    const stray: TraceTask = {
      ...donor,
      id: TaskId.make("t-stray"),
      prdSections: [prd(SECTION)],
      // It names a spec section that does not implement this PRD section.
      specSections: donor.specSections,
      title: "A task on the PRD section alone",
    };
    const withStray = UiStruct.evolve(reading, {
      trace: () =>
        TraceData.Success({ data: { ...demoTrace, tasks: Array.append(demoTrace.tasks, stray) } }),
    });
    const s = yield* viewerScene(withStray);
    s.pipe(pinned(SECTION))
      .expect(inside(data("spec-pane"), data("strays")))
      .toHaveText(containing("Tasks that name this section directly"))
      .expect(inside(data("strays"), data("task-row", "_:t-stray")))
      .toHaveText(containing(stray.title))
      .expect(inside(data("strays"), both(tag("button"), attr("aria-expanded"))))
      .toBeAbsent()
      .expect(inside(data("spec-pane"), tag("article")))
      .toHaveCount(Array.length(implementing(SECTION)) + 1);
  }),
);

it.effect("a section with a coverage note shows the note in place of the cards", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMountedAt("prd.v2-diverging-state"))
      .expect(data("spec-note"))
      .toHaveText(containing("Deferred"))
      .expect(cards)
      .toHaveCount(0)
      .expect(groups)
      .toHaveCount(0);
  }),
);

it.effect("scrolling to another section changes the cards", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMountedAt("prd.viewer.reader"))
      .expect(card("spec.viewer.reader"))
      .toExist()
      .expect(card(SPEC))
      .toBeAbsent()
      .pipe(prdScrolledTo(SECTION))
      .expect(card(SPEC))
      .toExist()
      .expect(card("spec.viewer.reader"))
      .toBeAbsent();
  }),
);

it.prop(
  "a card header flips that card alone, and the density resets every card",
  {
    density: Schema.Literals(["titles", "summary", "full"]),
    id: Schema.Literals(implementing(SECTION)),
  },
  ({ density, id }) => {
    const set = update(reading, Message.ClickedDensity({ density })).model;
    const flipped = update(set, Message.ClickedCardHeader({ id: SectionId.make(id) })).model;
    assert(flipped.reader.opened).toStrictEqual({ [id]: density !== "full" });
    const reset = update(flipped, Message.ClickedDensity({ density })).model;
    assert(reset.reader).toStrictEqual(set.reader);
    assert(reset.reader.opened).toStrictEqual({});
  },
);

it.effect(
  "the density control is one labelled group of three buttons with the summary pressed at first",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(pinned(SECTION))
        .expect(byRole("group", { name: "How much of the spec to show" }))
        .toExist()
        .expect(inside(groups, tag("button")))
        .toHaveCount(3)
        .expect(densityButton("Titles"))
        .toHaveAttribute("aria-pressed", "false")
        .expect(densityButton("Summary"))
        .toHaveAttribute("aria-pressed", "true")
        .expect(densityButton("Full spec"))
        .toHaveAttribute("aria-pressed", "false");
    }),
);

it.effect("a section with no summary shows none, and the others still do", () =>
  Effect.gen(function* () {
    const [first = "", ...others] = implementing("prd.viewer");
    const bare = UiStruct.evolve(reading, {
      trace: () =>
        TraceData.Success({
          data: {
            ...demoTrace,
            spec: {
              ...demoTrace.spec,
              sections: Array.map(demoTrace.spec.sections, (section) =>
                section.id === first ? { ...section, summary: null } : section,
              ),
            },
          },
        }),
    });
    assert(Array.length(others)).toBeGreaterThan(0);
    const s = yield* viewerScene(bare);
    s.pipe(pinned("prd.viewer"))
      .expect(card(first))
      .toExist()
      .expect(data("summary", first))
      .toBeAbsent()
      .expect(data("summary", others[0]))
      .toExist();
  }),
);

it.effect(
  "at full density a card shows its section's own markdown: tables and code, and no heading",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(pinned("prd.viewer"))
        .click(densityButton("Full spec"))
        .expect(inside(data("full-spec"), tag("table")))
        .toExist()
        .expect(inside(data("full-spec"), tag("pre")))
        .toExist()
        .expect(inside(data("full-spec"), data("section")))
        .toHaveCount(0)
        .expect(inside(data("full-spec"), tag("h2")))
        .toHaveCount(0)
        .expect(inside(data("full-spec"), tag("h3")))
        .toHaveCount(0);
    }),
);
