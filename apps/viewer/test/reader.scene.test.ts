import { PrdSectionId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Schema } from "effect";
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

import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { currentOf } from "../src/reader.ts";
import { escapeMessage } from "../src/subscription/escape.ts";
import { CopySectionId, update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { view } from "../src/view/view.ts";
import { canvasEnded, loaded, mounted, unmeasuredWires } from "./fixtures.ts";

const prd = (id: string) => PrdSectionId.make(id);
const prdIds = Array.map(demoTrace.prd.sections, (section) => section.id);

/** The reader open on the demo trace, as the Plan button leaves it. */
const reading = modifyFields(loaded, { screen: () => Screen.Reader() });

/** The pane's mount, answering with the section it found at the top. */
const scrolledTo = (id: string) =>
  Mount.resolveAll(
    [TrackPrdScroll, Message.ScrolledPrd({ id: prd(id) })],
    [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
    [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
  );
/** Later scrolls come from the same mount; a Scene has no hooks, so it feeds them in as it would. */
const scrolledAgainTo = (id: string) => Subscription.emit(Message.ScrolledPrd({ id: prd(id) }));

const heading = (id: string) => selector(`[data-section="${id}"]`);
const statusLine = (id: string) => selector(`[data-status-line="${id}"]`);
const idButton = (id: string) => selector(`[data-section-id="${id}"]`);
const currentHeadings = selector("[data-prd-pane] [data-current]");

it("the Plan button opens the reader, and the Canvas button goes back to the canvas", () => {
  scene(
    { update, view },
    given(loaded),
    mounted,
    expect(selector("[data-canvas]")).toExist(),
    expect(selector("[data-reader]")).toBeAbsent(),
    expect(role("group", { name: "Screen" })).toExist(),
    expect(selector("[data-toolbar] button[aria-current='page']")).toHaveText("Canvas"),
    click(role("button", { name: "Plan" })),
    ...canvasEnded(),
    expect(selector("[data-reader]")).toExist(),
    expect(selector("[data-canvas]")).toBeAbsent(),
    expect(role("region", { name: "PRD" })).toExist(),
    expect(role("button", { name: "Plan" })).toHaveAttr("aria-current", "page"),
    expect(role("button", { name: "Canvas" })).not.toHaveAttr("aria-current"),
    scrolledTo("prd.goal"),
    click(role("button", { name: "Canvas" })),
    Mount.expectEnded(TrackPrdScroll),
    Mount.expectEnded(ScrollStacksToBottom),
    Mount.expectEnded(MeasureWires),
    mounted,
    expect(selector("[data-canvas]")).toExist(),
    expect(selector("[data-reader]")).toBeAbsent(),
  );
});

it("the top bar names Cairn and the feature, and shows the search and who is here", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.goal"),
    expect(selector("[data-topbar] h1")).toHaveText("Cairn"),
    expect(selector("[data-topbar] [data-feature]")).toHaveText(demoTrace.feature),
    expect(role("combobox", { name: "Search sections and tasks" })).toExist(),
    expect(role("status")).toHaveText("Nobody else is here."),
  );
});

it("over the document sit its title and how many of the plan's tasks are done, with a meter", () => {
  // Counted from the demo's task statuses, so a plan that adds tasks does not change this test.
  const done = Array.length(
    Array.filter(demoTrace.tasks, ({ status }) => status === "done" || status === "landed"),
  );
  const total = Array.length(demoTrace.tasks);
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.goal"),
    expect(selector("[data-prd-title]")).toHaveText("Cairn MVP"),
    expect(selector("[data-plan-count]")).toHaveText(`${done} of ${total} tasks done`),
    expect(role("meter", { name: "Tasks done" })).toHaveAttr("aria-valuenow", `${done}`),
    expect(role("meter", { name: "Tasks done" })).toHaveAttr("aria-valuemax", `${total}`),
  );
});

it("every PRD heading below the title has its section ID and a status line or a coverage note", () => {
  const sections = Array.filter(demoTrace.prd.sections, (section) => section.level > 1);
  // The sections the spec leaves for later, needs no code for, or does not cover.
  const notes = Array.filter(
    demoTrace.sections,
    ({ id, status }) =>
      Array.some(sections, (section) => section.id === id) &&
      Array.some(["context", "deferred", "unmapped"], (note) => note === status),
  );
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.goal"),
    expectAll(all.selector("[data-prd-pane] [data-section]")).toHaveCount(
      Array.length(demoTrace.prd.sections),
    ),
    expectAll(all.selector("[data-section-id]")).toHaveCount(Array.length(demoTrace.prd.sections)),
    expectAll(all.selector("[data-status-line]")).toHaveCount(
      Array.length(sections) - Array.length(notes),
    ),
    expectAll(all.selector("[data-coverage]")).toHaveCount(Array.length(notes)),
    expect(idButton("prd.viewer")).toHaveText("prd.viewer"),
    expect(selector("[data-section='prd.cairn-mvp'] [data-status-line]")).toBeAbsent(),
  );
});

it("the status line of a section reads its status, spec sections and done tasks", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.goal"),
    expect(statusLine("prd.viewer")).toHaveText("in progress · 14 spec · 33/40 tasks"),
    expect(statusLine("prd.viewer.reader")).toHaveText("in progress · 2 spec · 2/3 tasks"),
    expect(statusLine("prd.viewer")).toHaveAttr("aria-pressed", "false"),
  );
});

it("a deferred or context section shows its note in place of a status line, and a built one shows none", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.goal"),
    expect(
      selector("[data-section='prd.v2-diverging-state'] [data-coverage='deferred']"),
    ).toHaveText("Deferred: the spec leaves this for later."),
    expect(statusLine("prd.v2-diverging-state")).toBeAbsent(),
    expect(selector("[data-section='prd.goal'] [data-coverage='context']")).toHaveText(
      "Context: the spec treats this as needing no code.",
    ),
    expect(selector("[data-section='prd.viewer'] [data-coverage]")).toBeAbsent(),
    expect(statusLine("prd.viewer")).toExist(),
  );
});

it("the section at the top is current, and a new one takes over as the pane scrolls", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.viewer.reader"),
    expectAll(all.selector("[data-prd-pane] [data-current]")).toHaveCount(1),
    expect(heading("prd.viewer.reader")).toHaveAttr("data-current", ""),
    scrolledAgainTo("prd.viewer.panes"),
    expectAll(all.selector("[data-prd-pane] [data-current]")).toHaveCount(1),
    expect(heading("prd.viewer.panes")).toHaveAttr("data-current", ""),
    expect(heading("prd.viewer.reader")).not.toHaveAttr("data-current"),
  );
});

it("nothing is current before the pane reports its top", () => {
  scene(
    { update, view },
    given(reading),
    expect(currentHeadings).toBeAbsent(),
    scrolledTo("prd.goal"),
    expect(currentHeadings).toExist(),
  );
});

it("a status line pins its section, which stays current while the pane scrolls, and the same button unpins it", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.viewer.reader"),
    click(statusLine("prd.viewer.spec-cards")),
    expect(statusLine("prd.viewer.spec-cards")).toHaveAttr("aria-pressed", "true"),
    expectAll(all.selector("[data-prd-pane] [aria-pressed='true']")).toHaveCount(1),
    expect(heading("prd.viewer.spec-cards")).toHaveAttr("data-current", ""),
    expect(heading("prd.viewer.reader")).not.toHaveAttr("data-current"),
    scrolledAgainTo("prd.viewer.models"),
    expect(heading("prd.viewer.spec-cards")).toHaveAttr("data-current", ""),
    expect(heading("prd.viewer.models")).not.toHaveAttr("data-current"),
    click(statusLine("prd.viewer.spec-cards")),
    expect(statusLine("prd.viewer.spec-cards")).toHaveAttr("aria-pressed", "false"),
    expect(heading("prd.viewer.spec-cards")).not.toHaveAttr("data-current"),
    expect(heading("prd.viewer.models")).toHaveAttr("data-current", ""),
  );
});

it("one section is pinned at a time: pinning another moves the pin", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.goal"),
    click(statusLine("prd.viewer.reader")),
    click(statusLine("prd.viewer.panes")),
    expect(statusLine("prd.viewer.reader")).toHaveAttr("aria-pressed", "false"),
    expect(statusLine("prd.viewer.panes")).toHaveAttr("aria-pressed", "true"),
    expect(heading("prd.viewer.panes")).toHaveAttr("data-current", ""),
  );
});

it("Escape unpins the pinned section", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.goal"),
    click(statusLine("prd.viewer.reader")),
    expect(heading("prd.viewer.reader")).toHaveAttr("data-current", ""),
    Subscription.emit(Message.PressedEscape()),
    expect(statusLine("prd.viewer.reader")).toHaveAttr("aria-pressed", "false"),
    expect(heading("prd.viewer.reader")).not.toHaveAttr("data-current"),
    expect(heading("prd.goal")).toHaveAttr("data-current", ""),
    // With nothing pinned Escape changes nothing.
    Subscription.emit(Message.PressedEscape()),
    expect(heading("prd.goal")).toHaveAttr("data-current", ""),
  );
});

it("clicking a section ID copies it, and the button reads copied once the clipboard took it", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.goal"),
    click(idButton("prd.viewer")),
    Command.expectExact(CopySectionId),
    Command.resolve(
      CopySectionId({ id: prd("prd.viewer") }),
      Message.CompletedCopySectionId({ id: prd("prd.viewer"), isCopied: true }),
    ),
    expect(idButton("prd.viewer")).toHaveText("copied"),
    expect(idButton("prd.goal")).toHaveText("prd.goal"),
    // A click on a status line is the next reader click: the button goes back to the ID.
    click(statusLine("prd.viewer")),
    expect(idButton("prd.viewer")).toHaveText("prd.viewer"),
  );
});

it("a refused copy leaves the ID as it was", () => {
  scene(
    { update, view },
    given(reading),
    scrolledTo("prd.goal"),
    click(idButton("prd.viewer")),
    Command.resolve(
      CopySectionId({ id: prd("prd.viewer") }),
      Message.CompletedCopySectionId({ id: prd("prd.viewer"), isCopied: false }),
    ),
    expect(idButton("prd.viewer")).toHaveText("prd.viewer"),
  );
});

it.prop(
  "a scroll changes only the section at the top",
  { id: Schema.Literals(prdIds) },
  ({ id }) => {
    const pinned = modifyFields(reading, {
      reader: (reader) => modifyFields(reader, { maybePinned: () => Option.some(prd("prd.goal")) }),
    });
    // The whole result: the model with only maybeAtTop changed, and no commands.
    assert(update(pinned, Message.ScrolledPrd({ id: prd(id) }))).toStrictEqual({
      model: modifyFields(pinned, {
        reader: (reader) => modifyFields(reader, { maybeAtTop: () => Option.some(prd(id)) }),
      }),
    });
  },
);

it.prop(
  "Escape unpins on the reader and does nothing on another screen",
  { id: Schema.Literals(prdIds) },
  ({ id }) => {
    const pinned = (screen: Screen) =>
      modifyFields(loaded, {
        reader: (reader) => modifyFields(reader, { maybePinned: () => Option.some(prd(id)) }),
        screen: () => screen,
      });
    const onReader = update(pinned(Screen.Reader()), Message.PressedEscape()).model;
    assert(onReader.reader.maybePinned).toStrictEqual(Option.none());
    const onCanvas = pinned(Screen.Canvas());
    assert(update(onCanvas, Message.PressedEscape()).model).toStrictEqual(onCanvas);
  },
);

it.prop(
  "the current section is the search result's, else the pin, else the one at the top",
  {
    maybeAtTop: Schema.Option(Schema.Literals(prdIds)),
    maybePinned: Schema.Option(Schema.Literals(prdIds)),
    maybeSearched: Schema.Option(Schema.Literals(prdIds)),
  },
  ({ maybeAtTop, maybePinned, maybeSearched }) => {
    const brand = Option.map(prd);
    const expected = Option.orElse(maybeSearched, () =>
      Option.orElse(maybePinned, () => maybeAtTop),
    );
    assert(
      currentOf(
        { maybeAtTop: brand(maybeAtTop), maybePinned: brand(maybePinned) },
        brand(maybeSearched),
      ),
    ).toStrictEqual(brand(expected));
  },
);

it.prop(
  "Escape is a message only when nothing handled it first",
  { defaultPrevented: Schema.Boolean, key: Schema.String },
  ({ defaultPrevented, key }) => {
    const message = escapeMessage({ defaultPrevented, key });
    assert(Option.isSome(message)).toBe(key === "Escape" && !defaultPrevented);
    assert(Option.getOrUndefined(message)).toStrictEqual(
      key === "Escape" && !defaultPrevented ? Message.PressedEscape() : undefined,
    );
  },
);
