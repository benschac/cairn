import { UiStruct } from "@effect/ui";
import { expect as assert, it } from "@effect/vitest";
import { Effect, MutableRef, Option } from "effect";

import { Message } from "../src/message.ts";
import { Screen, type Model } from "../src/model.ts";
import { update } from "../src/update.ts";
import { pressOnDivider, renderedWidthOf } from "../src/view/dividerView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import {
  byRole,
  containing,
  data,
  dividersRunning,
  loaded,
  prdScrolledTo,
  readerMounted,
  unmeasuredWires,
  viewerScene,
  wiresMeasuredAs,
  type ViewerSteps,
} from "./fixtures.ts";

const reading = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });

const prdDivider = byRole("separator", { name: "Resize the PRD pane" });
const specDivider = byRole("separator", { name: "Resize the spec pane" });
const stacksDivider = byRole("separator", { name: "Resize the stacks pane" });
const grid = data("reader-grid");

/** What `toHaveStyle(name, value)` was: the declaration is in the element's style attribute. */
const styled = (name: string, value: string) => containing(`${name}: ${value}`);

const pointerId = 4;
// The page's pointer moves and releases reach `update` through a subscription the scene does not
// hear, and a press is the PressDivider mount's stream, so a test applies each Message with `update`
// and is given the Model it leaves, with the reader's mounts started again.
const driven = (start: Model) => {
  const model = MutableRef.make(start);
  return (message: Message) => (s: ViewerSteps) => {
    MutableRef.update(model, (current) => update(current, message).model);
    return s.given(MutableRef.get(model)).pipe(readerMounted);
  };
};
const pressed = (
  pane: "prd" | "spec" | "stacks" | "detail",
  x: number,
  maybeWidth = Option.none<number>(),
) => Message.PressedDivider({ maybeWidth, pane, pointerId, x });
const movedTo = (x: number, id = pointerId, buttons = 1) =>
  Message.MovedResizePointer({ buttons, pointerId: id, x });
const released = (id = pointerId) => Message.ReleasedResizePointer({ pointerId: id });

it.effect(
  "each divider is a focusable vertical separator that reports its pane's width and limits",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .expect(prdDivider)
        .toHaveAttribute("aria-orientation", "vertical")
        .expect(prdDivider)
        .toHaveAttribute("tabindex", "0")
        .expect(prdDivider)
        .toHaveAttribute("aria-valuenow", "520")
        .expect(prdDivider)
        .toHaveAttribute("aria-valuemin", "300")
        .expect(prdDivider)
        .toHaveAttribute("aria-valuemax", "3200")
        .expect(specDivider)
        .toHaveAttribute("aria-valuenow", "440")
        .expect(specDivider)
        .toHaveAttribute("aria-valuemin", "260")
        .expect(specDivider)
        .toHaveAttribute("aria-valuemax", "3200")
        .expect(stacksDivider)
        .toHaveAttribute("aria-valuenow", "480")
        .expect(stacksDivider)
        .toHaveAttribute("aria-valuemin", "240")
        .expect(stacksDivider)
        .toHaveAttribute("aria-valuemax", "3200");
    }),
);

it.effect(
  "the grid's columns hold every pane's chosen width and scroll sideways rather than narrow one",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .expect(grid)
        .toHaveAttribute("style", styled("--prd-width", "520px"))
        .expect(grid)
        .toHaveAttribute("style", styled("--spec-width", "440px"))
        .expect(grid)
        .toHaveAttribute("style", styled("--stacks-width", "480px"))
        .expect(grid)
        .toHaveAttribute(
          "style",
          styled(
            "grid-template-columns",
            "var(--prd-width) 76px var(--spec-width) 76px var(--stacks-width) 16px minmax(320px, 1fr)",
          ),
        )
        .expect(grid)
        .toHaveAttribute("style", styled("overflow-x", "auto"));
    }),
);

/** The reader's mounts, with the stacks chart as wide as `chartWidth`. */
const fittedReader = (chartWidth: number) => (s: ViewerSteps) =>
  s
    .pipe(dividersRunning, prdScrolledTo("prd.goal"))
    .mounted(
      ScrollStacksToBottom,
      Message.CompletedScrollStacks({ maybeChartWidth: Option.some(chartWidth) }),
    )
    .pipe(wiresMeasuredAs(unmeasuredWires));

it.effect("the stacks pane opens as wide as its chart, within its limits", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(fittedReader(1234))
      .expect(stacksDivider)
      .toHaveAttribute("aria-valuenow", "1234")
      .expect(grid)
      .toHaveAttribute("style", styled("--stacks-width", "1234px"));
    const wide = yield* viewerScene(reading);
    wide.pipe(fittedReader(9000)).expect(stacksDivider).toHaveAttribute("aria-valuenow", "3200");
  }),
);

it("a chart measured after a person moved the stacks divider leaves their width alone", () => {
  const moved = update(
    reading,
    Message.PressedArrowOnDivider({ key: "ArrowRight", pane: "stacks" }),
  ).model;
  const measured = update(
    moved,
    Message.CompletedScrollStacks({ maybeChartWidth: Option.some(1234) }),
  ).model;
  assert(measured.widths.stacks).toBe(504);
  const other = update(
    reading,
    Message.PressedArrowOnDivider({ key: "ArrowRight", pane: "spec" }),
  ).model;
  assert(
    update(other, Message.CompletedScrollStacks({ maybeChartWidth: Option.some(1234) })).model
      .widths.stacks,
  ).toBe(1234);
});

it.effect("the stacks pane's divider widens it with the arrow keys and a drag", () =>
  Effect.gen(function* () {
    const send = driven(
      update(reading, Message.PressedArrowOnDivider({ key: "ArrowRight", pane: "stacks" })).model,
    );
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .keydown(stacksDivider, "ArrowRight")
      .expect(stacksDivider)
      .toHaveAttribute("aria-valuenow", "504")
      .expect(grid)
      .toHaveAttribute("style", styled("--stacks-width", "504px"))
      .pipe(send(pressed("stacks", 1000)), send(movedTo(1600)))
      .expect(stacksDivider)
      .toHaveAttribute("aria-valuenow", "1104")
      .pipe(send(released()))
      .expect(grid)
      .toHaveAttribute("style", styled("--stacks-width", "1104px"))
      .expect(specDivider)
      .toHaveAttribute("aria-valuenow", "440");
  }),
);

it.effect("the arrow keys move a focused divider by 24px, within its limits", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted)
      .keydown(prdDivider, "ArrowRight")
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "544")
      .keydown(prdDivider, "ArrowLeft")
      .keydown(prdDivider, "ArrowLeft")
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "496")
      .expect(specDivider)
      .toHaveAttribute("aria-valuenow", "440")
      .keydown(prdDivider, "Enter")
      .expectIgnored()
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "496");
  }),
);

it.effect(
  "pressing, moving and releasing sets the width to its width at the press plus the travel",
  () =>
    Effect.gen(function* () {
      const send = driven(reading);
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted, send(pressed("spec", 700)))
        .expect(grid)
        .toHaveAttribute("style", styled("user-select", "none"))
        .pipe(send(movedTo(760)))
        .expect(specDivider)
        .toHaveAttribute("aria-valuenow", "500")
        .pipe(send(movedTo(650)))
        .expect(specDivider)
        .toHaveAttribute("aria-valuenow", "390")
        .pipe(send(released()))
        .expect(grid)
        .toHaveAttribute("style", styled("user-select", "auto"))
        .pipe(send(movedTo(900)))
        .expect(specDivider)
        .toHaveAttribute("aria-valuenow", "390")
        .expect(prdDivider)
        .toHaveAttribute("aria-valuenow", "520");
    }),
);

it.effect("a drag stops at the pane's limits", () =>
  Effect.gen(function* () {
    const send = driven(reading);
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted, send(pressed("prd", 0)), send(movedTo(5000)))
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "3200")
      .pipe(send(movedTo(-5000)))
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "300");
  }),
);

it.effect("a move or release from another pointer changes nothing", () =>
  Effect.gen(function* () {
    const send = driven(reading);
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted, send(pressed("prd", 100)), send(movedTo(300, pointerId + 1)))
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "520")
      .pipe(send(released(pointerId + 1)), send(movedTo(130)))
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "550");
  }),
);

it.effect("a move with no button held ends a resize whose release was missed", () =>
  Effect.gen(function* () {
    const send = driven(reading);
    const s = yield* viewerScene(reading);
    s.pipe(readerMounted, send(pressed("prd", 100)), send(movedTo(130, pointerId, 0)))
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "520")
      .pipe(send(movedTo(200)))
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "520");
  }),
);

it.effect("a second press while one resize is going on is ignored", () =>
  Effect.gen(function* () {
    const send = driven(reading);
    const s = yield* viewerScene(reading);
    s.pipe(
      readerMounted,
      send(pressed("prd", 100)),
      send(
        Message.PressedDivider({
          maybeWidth: Option.none(),
          pane: "spec",
          pointerId: pointerId + 1,
          x: 9,
        }),
      ),
      send(movedTo(130)),
    )
      .expect(prdDivider)
      .toHaveAttribute("aria-valuenow", "550")
      .expect(specDivider)
      .toHaveAttribute("aria-valuenow", "440");
  }),
);

it("only the primary button presses a divider", () => {
  const press = pressOnDivider("prd");
  assert(press("mouse", 0, 0, 0, 0, 33, 0, 9, null)).toEqual(
    Option.some(
      Message.PressedDivider({ maybeWidth: Option.none(), pane: "prd", pointerId: 9, x: 33 }),
    ),
  );
  assert(press("mouse", 2, 0, 0, 0, 33, 0, 9, null)).toEqual(Option.none());
});

const boxOf = (width: number) => ({ getBoundingClientRect: () => ({ width }) });

it("a press carries the rendered width of the pane beside the divider, and of the panel around the detail divider", () => {
  const beside = { previousElementSibling: boxOf(312) };
  const inside = { closest: () => boxOf(480) };
  assert(renderedWidthOf("prd", beside)).toEqual(Option.some(312));
  assert(renderedWidthOf("spec", beside)).toEqual(Option.some(312));
  assert(renderedWidthOf("detail", inside)).toEqual(Option.some(480));
  assert(renderedWidthOf("prd", inside)).toEqual(Option.none());
  assert(renderedWidthOf("detail", beside)).toEqual(Option.none());
  assert(renderedWidthOf("prd", null)).toEqual(Option.none());
});

it.effect(
  "a drag starts from the rendered width when the grid holds the pane below the chosen one",
  () =>
    Effect.gen(function* () {
      const send = driven(reading);
      const s = yield* viewerScene(reading);
      s.pipe(readerMounted)
        .expect(prdDivider)
        .toHaveAttribute("aria-valuenow", "520")
        .pipe(send(pressed("prd", 100, Option.some(300))), send(movedTo(130)))
        // 300 rendered plus 30 of travel, not the chosen 520 plus 30.
        .expect(prdDivider)
        .toHaveAttribute("aria-valuenow", "330")
        .pipe(send(movedTo(90)))
        .expect(prdDivider)
        .toHaveAttribute("aria-valuenow", "300")
        .pipe(send(released()));
    }),
);
