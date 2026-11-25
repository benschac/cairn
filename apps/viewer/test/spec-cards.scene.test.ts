import { PrdSectionId, SectionId, TaskId, type TraceTask } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Result, Schema } from "effect";
import {
  Command,
  Mount,
  Subscription,
  all,
  click,
  expect,
  expectAll,
  given,
  role,
  scene,
  selector,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { patchPathOf } from "../src/codeView.ts";
import { FetchPatch } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { RenderDiff } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { Screen, Shown, TraceData } from "../src/model.ts";
import { cardsOf, statusWordOf } from "../src/reader.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { view } from "../src/view/view.ts";
import { focusedDetailHeading, loaded, unmeasuredWires } from "./fixtures.ts";

const prd = (id: string) => PrdSectionId.make(id);

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });

const scrolledTo = (id: string) =>
  Mount.resolveAll(
    [TrackPrdScroll, Message.ScrolledPrd({ id: prd(id) })],
    [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
    [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
  );
const statusLine = (id: string) => selector(`[data-status-line="${id}"]`);
const card = (id: string) => selector(`[data-spec="${id}"]`);
const header = (id: string) => selector(`[data-spec="${id}"] button[aria-expanded]`);
const cards = all.selector("[data-spec]");
const rows = all.selector("[data-spec-pane] [data-task-row]");
const summaries = all.selector("[data-spec-pane] [data-summary]");
const fulls = all.selector("[data-spec-pane] [data-full-spec]");

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
const pinned = (id: string) => [scrolledTo("prd.goal"), click(statusLine(id))];

it("a pinned section shows a card for each spec section that implements it, in the spec's order", () => {
  const ids = implementing(SECTION);
  assert(Array.length(ids)).toBeGreaterThan(0);
  scene(
    { update, view },
    given(reading),
    ...pinned(SECTION),
    expectAll(cards).toHaveCount(Array.length(ids)),
    ...Array.map(ids, (id) => expect(card(id)).toExist()),
    // A card holds its tasks as rows, each named by its spec section and task.
    expect(selector(`[data-spec="${SPEC}"] [data-task-row^="${SPEC}:"]`)).toExist(),
    expect(selector("[data-spec-pane] [role='group']")).toExist(),
  );
  assert(
    Array.map(cardsOf(demoTrace, prd(SECTION)).cards, (each) => each.section.id),
  ).toStrictEqual(ids);
});

it("the label counts the sections and names the PRD section, and a card's header counts its done tasks", () => {
  const { cards: found } = cardsOf(demoTrace, prd("prd.viewer.reader"));
  const first = Option.getOrThrow(Array.head(found));
  const done = Array.length(
    Array.filter(first.tasks, (task) => task.status === "done" || task.status === "landed"),
  );
  scene(
    { update, view },
    given(reading),
    ...pinned("prd.viewer.reader"),
    expect(selector("[data-spec-pane] .label")).toHaveText(
      `Spec · ${Array.length(found)} sections for Reading the plan`,
    ),
    expect(header(first.section.id)).toContainText(first.section.title),
    expect(header(first.section.id)).toContainText(`${done}/${Array.length(first.tasks)}`),
  );
});

it("a task row shows its status, ID, title and the commit count or the status word, and opens the task", () => {
  const task = Option.getOrThrow(
    Array.findFirst(demoTrace.tasks, (each) => Array.some(each.specSections, (id) => id === SPEC)),
  );
  const row = selector(`[data-task-row="${SPEC}:${task.id}"]`);
  scene(
    { update, view },
    given(reading),
    ...pinned(SECTION),
    expect(row).toContainText(task.id),
    expect(row).toContainText(task.title),
    expect(row).toContainText(
      Array.isReadonlyArrayEmpty(task.commits)
        ? statusWordOf(task.status)
        : `${Array.length(task.commits)} commit`,
    ),
    click(row),
    focusedDetailHeading,
    ...Array.flatMap(Option.toArray(patchPathOf(task, Shown.WholeTask())), (path) => [
      Command.resolve(
        FetchPatch({ path }),
        // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
        Message.ReceivedPatch({ path, result: Result.succeed("") }),
      ),
      Mount.resolve(
        RenderDiff,
        // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
        Message.CompletedRenderDiff(),
      ),
    ]),
  );
  const model = update(reading, Message.ClickedTask({ id: task.id })).model;
  assert(model.detail).toStrictEqual([{ id: task.id, kind: "task" }]);
});

it.each<{
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
])("marks a spec completed for $statuses: $completed", ({ statuses, completed }) => {
  const donor = Option.getOrThrow(
    Array.findFirst(demoTrace.tasks, (task) => Array.some(task.specSections, (id) => id === SPEC)),
  );
  const model = modifyFields(reading, {
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
  const badge = selector(`[data-spec="${SPEC}"] .card-completed`);
  scene(
    { update, view },
    given(model),
    ...pinned(SECTION),
    expect(card(SPEC)).toHaveAttr("data-completed", `${completed}`),
    completed ? expect(badge).toContainText("Completed") : expect(badge).toBeAbsent(),
    click(role("button", { name: "Titles" })),
    completed ? expect(badge).toExist() : expect(badge).toBeAbsent(),
    click(role("button", { name: "Full spec" })),
    completed ? expect(badge).toExist() : expect(badge).toBeAbsent(),
  );
});

it("the control steps through titles, summaries and full sections while the rows stay", () => {
  const ids = implementing(SECTION);
  const { cards: found, strays } = cardsOf(demoTrace, prd(SECTION));
  const rowCount = Array.length(Array.flatMap(found, (each) => each.tasks)) + Array.length(strays);
  scene(
    { update, view },
    given(reading),
    ...pinned(SECTION),
    expect(role("button", { name: "Summary" })).toHaveAttr("aria-pressed", "true"),
    expectAll(summaries).toHaveCount(
      Array.length(
        Array.filter(
          demoTrace.spec.sections,
          (s) => Array.contains(ids, s.id) && s.summary !== null,
        ),
      ),
    ),
    expectAll(fulls).toHaveCount(0),
    expectAll(rows).toHaveCount(rowCount),
    click(role("button", { name: "Titles" })),
    expect(role("button", { name: "Titles" })).toHaveAttr("aria-pressed", "true"),
    expect(role("button", { name: "Summary" })).toHaveAttr("aria-pressed", "false"),
    expectAll(summaries).toHaveCount(0),
    expectAll(fulls).toHaveCount(0),
    expectAll(rows).toHaveCount(rowCount),
    click(role("button", { name: "Full spec" })),
    expectAll(fulls).toHaveCount(Array.length(ids)),
    expectAll(summaries).toHaveCount(0),
    expectAll(rows).toHaveCount(rowCount),
    // The full section opens with its ID and has the section's own key list as chips.
    expect(selector(`[data-full-spec="${SPEC}"] [data-key-row="Implements"]`)).toExist(),
    expect(selector(`[data-full-spec="${SPEC}"]`)).toContainText(SPEC),
    click(role("button", { name: "Summary" })),
    expectAll(fulls).toHaveCount(0),
  );
});

it("a card opens and closes alone, and the control resets it", () => {
  const ids = Array.map(cardsOf(demoTrace, prd("prd.viewer")).cards, (each) => each.section.id);
  const first = Option.getOrThrow(Array.get(ids, 0));
  const second = Option.getOrThrow(Array.get(ids, 1));
  assert(Array.length(ids)).toBeGreaterThan(2);
  scene(
    { update, view },
    given(reading),
    ...pinned("prd.viewer"),
    expect(header(first)).toHaveAttr("aria-expanded", "false"),
    click(header(first)),
    expect(header(first)).toHaveAttr("aria-expanded", "true"),
    expect(selector(`[data-full-spec="${first}"]`)).toExist(),
    expect(selector(`[data-summary="${first}"]`)).toBeAbsent(),
    // The others are as they were.
    expect(header(second)).toHaveAttr("aria-expanded", "false"),
    expectAll(fulls).toHaveCount(1),
    click(header(first)),
    expect(header(first)).toHaveAttr("aria-expanded", "false"),
    expectAll(fulls).toHaveCount(0),
    // Open again, then change the control: the card goes back to what the control says.
    click(header(first)),
    click(role("button", { name: "Titles" })),
    expect(header(first)).toHaveAttr("aria-expanded", "false"),
    expectAll(fulls).toHaveCount(0),
    // At full density a card can be closed on its own.
    click(role("button", { name: "Full spec" })),
    click(header(first)),
    expect(header(first)).toHaveAttr("aria-expanded", "false"),
    expectAll(fulls).toHaveCount(Array.length(ids) - 1),
  );
});

it("a task that names the section but none of its spec sections is in a last card", () => {
  const donor = Option.getOrThrow(Array.head(demoTrace.tasks));
  const stray: TraceTask = {
    ...donor,
    id: TaskId.make("t-stray"),
    prdSections: [prd(SECTION)],
    // It names a spec section that does not implement this PRD section.
    specSections: donor.specSections,
    title: "A task on the PRD section alone",
  };
  const withStray = modifyFields(reading, {
    trace: () =>
      TraceData.Success({ data: { ...demoTrace, tasks: Array.append(demoTrace.tasks, stray) } }),
  });
  scene(
    { update, view },
    given(withStray),
    ...pinned(SECTION),
    expect(selector("[data-spec-pane] [data-strays]")).toContainText(
      "Tasks that name this section directly",
    ),
    expect(selector("[data-strays] [data-task-row='_:t-stray']")).toContainText(stray.title),
    expect(selector("[data-strays] button[aria-expanded]")).toBeAbsent(),
    expectAll(all.selector("[data-spec-pane] article")).toHaveCount(
      Array.length(implementing(SECTION)) + 1,
    ),
  );
});

it("a section with a coverage note shows the note in place of the cards", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.v2-diverging-state"),
    expect(selector("[data-spec-note]")).toContainText("Deferred"),
    expectAll(cards).toHaveCount(0),
    expectAll(all.selector("[data-spec-pane] [role='group']")).toHaveCount(0),
  );
});

it("scrolling to another section changes the cards", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.viewer.reader"),
    expect(card("spec.viewer.reader")).toExist(),
    expect(card(SPEC)).toBeAbsent(),
    Subscription.emit(Message.ScrolledPrd({ id: prd(SECTION) })),
    expect(card(SPEC)).toExist(),
    expect(card("spec.viewer.reader")).toBeAbsent(),
  );
});

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

it("the density control is one labelled group of three buttons with the summary pressed at first", () => {
  scene(
    { update, view },
    given(reading),
    ...pinned(SECTION),
    expect(role("group", { name: "How much of the spec to show" })).toExist(),
    expectAll(all.selector("[data-spec-pane] [role='group'] button")).toHaveCount(3),
    expect(role("button", { name: "Titles" })).toHaveAttr("aria-pressed", "false"),
    expect(role("button", { name: "Summary" })).toHaveAttr("aria-pressed", "true"),
    expect(role("button", { name: "Full spec" })).toHaveAttr("aria-pressed", "false"),
  );
});

it("a section with no summary shows none, and the others still do", () => {
  const [first = "", ...others] = implementing("prd.viewer");
  const bare = modifyFields(reading, {
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
  scene(
    { update, view },
    given(bare),
    ...pinned("prd.viewer"),
    expect(card(first)).toExist(),
    expect(selector(`[data-summary="${first}"]`)).toBeAbsent(),
    expect(selector(`[data-summary="${others[0]}"]`)).toExist(),
  );
});

it("at full density a card shows its section's own markdown: tables and code, and no heading", () => {
  scene(
    { update, view },
    given(reading),
    ...pinned("prd.viewer"),
    click(role("button", { name: "Full spec" })),
    expect(selector("[data-full-spec] table")).toExist(),
    expect(selector("[data-full-spec] pre")).toExist(),
    expectAll(all.selector("[data-full-spec] [data-section]")).toHaveCount(0),
    expectAll(all.selector("[data-full-spec] h2")).toHaveCount(0),
    expectAll(all.selector("[data-full-spec] h3")).toHaveCount(0),
  );
});
