import { PrdSectionId } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Array } from "effect";
import { Mount, all, click, expect, expectAll, given, role, scene, selector } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen } from "../src/model.ts";
import { ranOf } from "../src/reader.ts";
import { update } from "../src/update.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { view } from "../src/view/view.ts";
import { loaded, wiresMounted } from "./fixtures.ts";

const reading = modifyFields(loaded, { screen: () => Screen.Reader() });

/** The reader open on the section whose cards list t6, which ran, and tasks that did not. */
const opened = [
  Mount.resolve(
    TrackPrdScroll,
    Message.ScrolledPrd({ id: PrdSectionId.make("prd.viewer.models") }),
  ),
  Mount.resolve(ScrollStacksToBottom, Message.CompletedScrollStacks()),
  wiresMounted,
] as const;

const modelsSwitch = role("switch", { name: "Models and reasoning" });
const chip = (id: string) => selector(`[data-stacks-pane] [data-task="${id}"]`);
const kinds = ["chip", "mark", "square"] as const;
const present = Array.map(kinds, (kind) => expect(selector(`[data-model-${kind}]`)).toExist());
const absent = Array.map(kinds, (kind) =>
  expectAll(all.selector(`[data-model-${kind}]`)).toHaveCount(0),
);
const ran = Array.filter(demoTrace.tasks, (task) => ranOf(task).ran);
const planned = Array.filter(demoTrace.tasks, (task) => !ranOf(task).ran);

it("the demo trace has tasks that ran and tasks that are only planned, and the switch starts on", () => {
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(modelsSwitch).toHaveAttr("aria-checked", "true"),
    expect(chip("t6")).toHaveAttr("data-ran", "true"),
    expect(chip("t6")).toHaveAttr("data-model", "sonnet"),
    expect(chip("t91")).toHaveAttr("data-ran", "false"),
    expectAll(all.selector("[data-stacks-pane] [data-task][data-ran='true']")).toHaveCount(
      Array.length(ran),
    ),
    expectAll(all.selector("[data-stacks-pane] [data-task][data-ran='false']")).toHaveCount(
      Array.length(planned),
    ),
  );
});

it("a stack chip carries its model's mark, and a card's header and rows carry squares and chips", () => {
  scene(
    { update, view },
    given(reading),
    ...opened,
    expect(selector("[data-stacks-pane] [data-task='t6'] [data-model-mark]")).toHaveText("lo"),
    expect(selector("[data-stacks-pane] [data-task='t6'] [data-model-mark]")).toHaveAttr(
      "title",
      "Ran on sonnet, low reasoning",
    ),
    expect(selector("[data-stacks-pane] [data-task='t91'] [data-model-mark]")).toHaveAttr(
      "title",
      "Planned for sonnet, medium reasoning",
    ),
    expect(selector("[data-spec-pane] [data-model-square]")).toExist(),
    expect(selector("[data-spec-pane] [data-model-chip]")).toExist(),
    expect(selector("[data-spec-pane] [data-model-chip][data-ran='false']")).toHaveAttr(
      "title",
      "Planned for sonnet, medium reasoning",
    ),
  );
});

it("turning the switch off removes every chip, mark and square, and on brings them back", () => {
  scene(
    { update, view },
    given(reading),
    ...opened,
    ...present,
    click(modelsSwitch),
    expect(modelsSwitch).toHaveAttr("aria-checked", "false"),
    ...absent,
    expectAll(all.selector("[data-model]")).toHaveCount(0),
    expectAll(all.selector("[data-ran]")).toHaveCount(0),
    expect(chip("t6")).toHaveAttr("data-done", ""),
    expect(selector("[data-legend] [data-legend-model]")).toBeAbsent(),
    click(modelsSwitch),
    expect(modelsSwitch).toHaveAttr("aria-checked", "true"),
    ...present,
    expect(chip("t6")).toHaveAttr("data-model", "sonnet"),
    expect(selector("[data-legend] [data-legend-model='opus']")).toExist(),
  );
});
