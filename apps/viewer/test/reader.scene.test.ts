import { PrdSectionId, TaskId } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Locator } from "@effect/ui/testing";
import { Array, Effect, Option, Schema } from "effect";
import { modifyFields } from "foldkit/struct";

import { viewerBridge } from "../src/app.ts";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen, WHOLE_TASK } from "../src/model.ts";
import { currentOf } from "../src/reader.ts";
import { escapeMessage } from "../src/subscription/escape.ts";
import { CopySectionId, update } from "../src/update.ts";
import {
  byRole,
  data,
  inside,
  loaded,
  prdScrolledTo,
  pushedUrl,
  readerMounted,
  readerMountedAt,
  resolved,
  tag,
  viewerScene,
} from "./fixtures.ts";

const prd = (id: string) => PrdSectionId.make(id);
const prdIds = Array.map(demoTrace.prd.sections, (section) => section.id);

/** The reader open on the demo trace, as the Plan button leaves it. */
const reading = modifyFields(loaded, { screen: () => Screen.Reader() });

const heading = (id: string) => data("section", id);
const statusLine = (id: string) => data("status-line", id);
const idButton = (id: string) => data("section-id", id);
const currentHeadings = inside(data("prd-pane"), data("current"));

it.effect("the top bar names Cairn and the feature, and shows the search and who is here", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .expect(inside(data("topbar"), tag("h1")))
      .toHaveText("Cairn")
      .expect(inside(data("topbar"), data("feature")))
      .toHaveText(demoTrace.feature)
      .expect(byRole("combobox", { name: "Search sections and tasks" }))
      .toExist()
      .expect(byRole("status"))
      .toHaveText("Nobody else is here.");
  }),
);

it.effect(
  "over the document sit its title and how many of the plan's tasks are done, with a meter",
  () =>
    Effect.gen(function* () {
      // Counted from the demo's task statuses, so a plan that adds tasks does not change this test.
      const done = Array.length(
        Array.filter(demoTrace.tasks, ({ status }) => status === "done" || status === "landed"),
      );
      const total = Array.length(demoTrace.tasks);
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .expect(data("prd-title"))
        .toHaveText("Cairn MVP")
        .expect(data("plan-count"))
        .toHaveText(`${done} of ${total} tasks done`)
        .expect(byRole("meter", { name: "Tasks done" }))
        .toHaveAttribute("aria-valuenow", `${done}`)
        .expect(byRole("meter", { name: "Tasks done" }))
        .toHaveAttribute("aria-valuemax", `${total}`);
    }),
);

it.effect(
  "every PRD heading below the title has its section ID and a status line or a coverage note",
  () =>
    Effect.gen(function* () {
      const sections = Array.filter(demoTrace.prd.sections, (section) => section.level > 1);
      // The sections the spec leaves for later, needs no code for, or does not cover.
      const notes = Array.filter(
        demoTrace.sections,
        ({ id, status }) =>
          Array.some(sections, (section) => section.id === id) &&
          Array.some(["context", "deferred", "unmapped"], (note) => note === status),
      );
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .expect(inside(data("prd-pane"), data("section")))
        .toHaveCount(Array.length(demoTrace.prd.sections))
        .expect(data("section-id"))
        .toHaveCount(Array.length(demoTrace.prd.sections))
        .expect(data("status-line"))
        .toHaveCount(Array.length(sections) - Array.length(notes))
        .expect(data("coverage"))
        .toHaveCount(Array.length(notes))
        .expect(idButton("prd.viewer"))
        .toHaveText("prd.viewer")
        .expect(inside(data("section", "prd.cairn-mvp"), data("status-line")))
        .toBeAbsent();
    }),
);

it.effect("the status line of a section reads its status, spec sections and done tasks", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .expect(statusLine("prd.viewer"))
      .toHaveText("in progress · 14 spec · 37/41 tasks")
      .expect(statusLine("prd.viewer.reader"))
      .toHaveText("in progress · 2 spec · 2/3 tasks")
      .expect(statusLine("prd.viewer"))
      .toHaveAttribute("aria-pressed", "false");
  }),
);

it.effect(
  "a deferred or context section shows its note in place of a status line, and a built one shows none",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .expect(inside(data("section", "prd.v2-diverging-state"), data("coverage", "deferred")))
        .toHaveText("Deferred: the spec leaves this for later.")
        .expect(statusLine("prd.v2-diverging-state"))
        .toBeAbsent()
        .expect(inside(data("section", "prd.goal"), data("coverage", "context")))
        .toHaveText("Context: the spec treats this as needing no code.")
        .expect(inside(data("section", "prd.viewer"), data("coverage")))
        .toBeAbsent()
        .expect(statusLine("prd.viewer"))
        .toExist();
    }),
);

it.effect("the section at the top is current, and a new one takes over as the pane scrolls", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMountedAt("prd.viewer.reader"))
      .expect(currentHeadings)
      .toHaveCount(1)
      .expect(heading("prd.viewer.reader"))
      .toHaveAttribute("data-current", "")
      // Later scrolls come from the same mount, which takes one value per step.
      .pipe(prdScrolledTo("prd.viewer.panes"))
      .expect(currentHeadings)
      .toHaveCount(1)
      .expect(heading("prd.viewer.panes"))
      .toHaveAttribute("data-current", "")
      .expect(heading("prd.viewer.reader"))
      .toHaveAttribute("data-current", false);
  }),
);

it.effect("nothing is current before the pane reports its top", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.expect(currentHeadings).toBeAbsent().pipe(readerMounted).expect(currentHeadings).toExist();
  }),
);

it.effect(
  "a status line pins its section, which stays current while the pane scrolls, and the same button unpins it",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(readerMountedAt("prd.viewer.reader"))
        .click(statusLine("prd.viewer.spec-cards"))
        .pipe(pushedUrl)
        .expect(statusLine("prd.viewer.spec-cards"))
        .toHaveAttribute("aria-pressed", "true")
        .expect(inside(data("prd-pane"), Locator.attr("aria-pressed", "true")))
        .toHaveCount(1)
        .expect(heading("prd.viewer.spec-cards"))
        .toHaveAttribute("data-current", "")
        .expect(heading("prd.viewer.reader"))
        .toHaveAttribute("data-current", false)
        .pipe(prdScrolledTo("prd.viewer.models"))
        .expect(heading("prd.viewer.spec-cards"))
        .toHaveAttribute("data-current", "")
        .expect(heading("prd.viewer.models"))
        .toHaveAttribute("data-current", false)
        .click(statusLine("prd.viewer.spec-cards"))
        .pipe(pushedUrl)
        .expect(statusLine("prd.viewer.spec-cards"))
        .toHaveAttribute("aria-pressed", "false")
        .expect(heading("prd.viewer.spec-cards"))
        .toHaveAttribute("data-current", false)
        .expect(heading("prd.viewer.models"))
        .toHaveAttribute("data-current", "");
    }),
);

it.effect("one section is pinned at a time: pinning another moves the pin", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(statusLine("prd.viewer.reader"))
      .pipe(pushedUrl)
      .click(statusLine("prd.viewer.panes"))
      .pipe(pushedUrl)
      .expect(statusLine("prd.viewer.reader"))
      .toHaveAttribute("aria-pressed", "false")
      .expect(statusLine("prd.viewer.panes"))
      .toHaveAttribute("aria-pressed", "true")
      .expect(heading("prd.viewer.panes"))
      .toHaveAttribute("data-current", "");
  }),
);

it.effect("Escape unpins the pinned section", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(statusLine("prd.viewer.reader"))
      .pipe(pushedUrl)
      .expect(heading("prd.viewer.reader"))
      .toHaveAttribute("data-current", "")
      .fireDocument("keydown", { key: "Escape" })
      .pipe(pushedUrl)
      .expect(statusLine("prd.viewer.reader"))
      .toHaveAttribute("aria-pressed", "false")
      .expect(heading("prd.viewer.reader"))
      .toHaveAttribute("data-current", false)
      .expect(heading("prd.goal"))
      .toHaveAttribute("data-current", "")
      // With nothing pinned Escape changes nothing.
      .fireDocument("keydown", { key: "Escape" })
      .expect(heading("prd.goal"))
      .toHaveAttribute("data-current", "");
  }),
);

it.effect(
  "clicking a section ID copies it, and the button reads copied once the clipboard took it",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .click(idButton("prd.viewer"))
        .expectExact(viewerBridge.commandOf(CopySectionId))
        .pipe(
          resolved(
            CopySectionId,
            Message.CompletedCopySectionId({ id: prd("prd.viewer"), isCopied: true }),
          ),
        )
        .expect(idButton("prd.viewer"))
        .toHaveText("copied")
        .expect(idButton("prd.goal"))
        .toHaveText("prd.goal")
        // A click on a status line is the next reader click: the button goes back to the ID.
        .click(statusLine("prd.viewer"))
        .pipe(pushedUrl)
        .expect(idButton("prd.viewer"))
        .toHaveText("prd.viewer");
    }),
);

it.effect("a refused copy leaves the ID as it was", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .click(idButton("prd.viewer"))
      .pipe(
        resolved(
          CopySectionId,
          Message.CompletedCopySectionId({ id: prd("prd.viewer"), isCopied: false }),
        ),
      )
      .expect(idButton("prd.viewer"))
      .toHaveText("prd.viewer");
  }),
);

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
  "Escape unpins on the reader and does nothing on the code view",
  { id: Schema.Literals(prdIds) },
  ({ id }) => {
    const pinned = (screen: Screen) =>
      modifyFields(loaded, {
        reader: (reader) => modifyFields(reader, { maybePinned: () => Option.some(prd(id)) }),
        screen: () => screen,
      });
    const onReader = update(pinned(Screen.Reader()), Message.PressedEscape()).model;
    assert(onReader.reader.maybePinned).toStrictEqual(Option.none());
    const onCode = pinned(
      Screen.Code({
        maybeFile: Option.none(),
        maybeLines: Option.none(),
        shown: WHOLE_TASK,
        taskId: TaskId.make("t1"),
      }),
    );
    assert(update(onCode, Message.PressedEscape()).model).toStrictEqual(onCode);
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
