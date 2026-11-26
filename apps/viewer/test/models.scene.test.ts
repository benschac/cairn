import { UiStruct } from "@effect/ui";
import { it } from "@effect/vitest";
import { Array, Effect } from "effect";

import { demoTrace } from "../src/demo.ts";
import { Screen } from "../src/model.ts";
import { ranOf } from "../src/reader.ts";
import {
  both,
  byRole,
  data,
  first,
  inside,
  loaded,
  readerMountedAt,
  unfolded,
  viewerScene,
  type ViewerSteps,
} from "./fixtures.ts";

const folded = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });
/** With every finished trunk unfolded, so the chips these scenes look at are drawn. */
const reading = unfolded(folded);

/** The reader open on the section whose cards list t6, which ran, and tasks that did not. */
const opened = readerMountedAt("prd.viewer.models");

const modelsSwitch = byRole("switch", { name: "Models and reasoning" });
const stacks = data("stacks-pane");
const chip = (id: string) => inside(stacks, data("task", id));
const kinds = ["chip", "mark", "square"] as const;
const present = (s: ViewerSteps) =>
  Array.reduce(kinds, s, (steps, kind) => steps.expect(data(`model-${kind}`)).toExist());
const absent = (s: ViewerSteps) =>
  Array.reduce(kinds, s, (steps, kind) => steps.expect(data(`model-${kind}`)).toHaveCount(0));
const ran = Array.filter(demoTrace.tasks, (task) => ranOf(task).ran);
const planned = Array.filter(demoTrace.tasks, (task) => !ranOf(task).ran);

it.effect(
  "the demo trace has tasks that ran and tasks that are only planned, and the switch starts on",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(opened)
        .expect(modelsSwitch)
        .toHaveAttribute("aria-checked", "true")
        .expect(chip("t6"))
        .toHaveAttribute("data-ran", "true")
        .expect(chip("t6"))
        .toHaveAttribute("data-model", "sonnet")
        .expect(chip("t91"))
        .toHaveAttribute("data-ran", "false")
        .expect(inside(stacks, both(data("task"), data("ran", "true"))))
        .toHaveCount(Array.length(ran))
        .expect(inside(stacks, both(data("task"), data("ran", "false"))))
        .toHaveCount(Array.length(planned));
    }),
);

const markOf = (id: string) => inside(chip(id), data("model-mark"));

it.effect(
  "a stack chip carries its model's mark, and a card's header and rows carry squares and chips",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      const specPane = data("spec-pane");
      s.pipe(opened)
        .expect(markOf("t6"))
        .toHaveText("lo")
        .expect(markOf("t6"))
        .toHaveAttribute("title", "Ran on sonnet, low reasoning")
        .expect(markOf("t91"))
        .toHaveAttribute("title", "Planned for sonnet, medium reasoning")
        .expect(first(inside(specPane, data("model-square"))))
        .toExist()
        .expect(first(inside(specPane, data("model-chip"))))
        .toExist()
        .expect(first(inside(specPane, both(data("model-chip"), data("ran", "false")))))
        .toHaveAttribute("title", "Planned for sonnet, medium reasoning");
    }),
);

it.effect("turning the switch changes the attribute the wires are measured again on", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(folded);
    s.pipe(opened)
      .expect(data("wires"))
      .toHaveAttribute("data-wires", "prd.viewer.models|models")
      .click(modelsSwitch)
      .expect(data("wires"))
      .toHaveAttribute("data-wires", "prd.viewer.models|plain")
      .click(modelsSwitch)
      .expect(data("wires"))
      .toHaveAttribute("data-wires", "prd.viewer.models|models");
  }),
);

it.effect(
  "turning the switch off removes every chip, mark and square, and on brings them back",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(reading);
      s.pipe(opened, present)
        .click(modelsSwitch)
        .expect(modelsSwitch)
        .toHaveAttribute("aria-checked", "false")
        .pipe(absent)
        .expect(data("model"))
        .toHaveCount(0)
        .expect(data("ran"))
        .toHaveCount(0)
        .expect(chip("t6"))
        .toHaveAttribute("data-done", "")
        .expect(inside(data("legend"), data("legend-model")))
        .toBeAbsent()
        .click(modelsSwitch)
        .expect(modelsSwitch)
        .toHaveAttribute("aria-checked", "true")
        .pipe(present)
        .expect(chip("t6"))
        .toHaveAttribute("data-model", "sonnet")
        .expect(inside(data("legend"), data("legend-model", "opus")))
        .toExist();
    }),
);
