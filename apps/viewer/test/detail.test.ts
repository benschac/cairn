import { type Command, UiStruct } from "@effect/ui";
import { SectionId, TaskId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Schema } from "effect";

import { CLOSED, cutBackTo, extendedBy, nodeShownBy, openedOn, wentBack } from "../src/detail.ts";
import { Message } from "../src/message.ts";
import { Screen, WHOLE_TASK } from "../src/model.ts";
import { Node } from "../src/trace.ts";
import { FocusDetailHeading, update } from "../src/update.ts";
import { loaded } from "./fixtures.ts";

const Trail = Schema.Array(Node);
const Steps = Schema.NonEmptyArray(Node);
const reading = UiStruct.evolve(loaded, { screen: () => Screen.Reader() });
const open = (detail: ReadonlyArray<Node>) => UiStruct.evolve(reading, { detail: () => detail });
/** The commands an update asked for, by name and args; none when it asked for none. */
const commandsOf = (result: { readonly commands?: ReadonlyArray<Command.Data> }) =>
  Array.map(
    Option.getOrElse(Option.fromUndefinedOr(result.commands), Array.empty),
    ({ args, name }) => ({
      args,
      name,
    }),
  );
const aTask = Schema.decodeSync(TaskId)("t1");
const aSection = Schema.decodeSync(SectionId)("spec.viewer.reader");

it.prop(
  "opening from outside always gives a trail of one, whatever was open",
  { before: Trail, node: Node },
  ({ before, node }) => {
    expect(openedOn(node)).toEqual([node]);
    const next = update(open(before), Message.ClickedTask({ id: aTask })).model;
    expect(next.detail).toEqual([{ id: aTask, kind: "task" }]);
  },
);

it.prop(
  "cutting back to a step keeps exactly the steps up to it",
  { index: Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 0 })), trail: Steps },
  ({ index, trail }) => {
    const cut = cutBackTo(trail, index);
    if (index < Array.length(trail)) {
      expect(cut).toEqual(Array.take(trail, index + 1));
      expect(update(open(trail), Message.ClickedTrailStep({ index })).model.detail).toEqual(cut);
    } else {
      expect(cut).toEqual(trail);
    }
  },
);

it.prop("a step the trail does not have changes nothing", { trail: Trail }, ({ trail }) => {
  expect(cutBackTo(trail, -1)).toEqual(trail);
  expect(update(open(trail), Message.ClickedTrailStep({ index: -1 })).model.detail).toEqual(trail);
});

it.prop("going back from one step closes the panel", { node: Node }, ({ node }) => {
  expect(wentBack([node])).toEqual(CLOSED);
  expect(update(open([node]), Message.PressedEscape()).model.detail).toEqual(CLOSED);
});

it.prop("going back removes only the last step", { trail: Steps }, ({ trail }) => {
  expect(wentBack(trail)).toEqual(Array.dropRight(trail, 1));
  expect(update(open(trail), Message.PressedEscape()).model.detail).toEqual(
    Array.dropRight(trail, 1),
  );
});

it.prop(
  "a node opened from the panel is added at the end",
  { node: Node, trail: Steps },
  ({ node, trail }) => {
    const next = update(open(trail), Message.ClickedDetailNode({ node })).model.detail;
    expect(next).toEqual(extendedBy(trail, node));
    expect(nodeShownBy(next)).toEqual(Option.some(node));
    expect(Array.take(next, Array.length(trail))).toEqual(trail);
  },
);

it.prop("closing empties the trail from any depth", { trail: Trail }, ({ trail }) => {
  expect(update(open(trail), Message.ClickedCloseDetail()).model.detail).toEqual(CLOSED);
});

it("focus goes to the heading when the panel opens or its last node changes, and only then", () => {
  const task = { id: aTask, kind: "task" } as const;
  const section = { id: aSection, kind: "section" } as const;
  const focus = commandsOf({ commands: [FocusDetailHeading.make()] });
  expect(commandsOf(update(reading, Message.ClickedTask({ id: aTask })))).toEqual(focus);
  expect(commandsOf(update(open([task]), Message.ClickedDetailNode({ node: section })))).toEqual(
    focus,
  );
  expect(commandsOf(update(open([task, section]), Message.ClickedTrailStep({ index: 0 })))).toEqual(
    focus,
  );
  expect(commandsOf(update(open([task, section]), Message.PressedEscape()))).toEqual(focus);
  // The same node is already shown; closing leaves nothing to focus.
  expect(commandsOf(update(open([task]), Message.ClickedTask({ id: aTask })))).toEqual([]);
  expect(commandsOf(update(open([task, section]), Message.ClickedTrailStep({ index: 1 })))).toEqual(
    [],
  );
  expect(commandsOf(update(open([task]), Message.PressedEscape()))).toEqual([]);
  expect(commandsOf(update(open([task]), Message.ClickedCloseDetail()))).toEqual([]);
});

it("Escape pops the trail only on the reader; on the code view it leaves the panel alone", () => {
  const trail = [{ id: aTask, kind: "task" } as const];
  const onCode = UiStruct.evolve(loaded, {
    detail: () => trail,
    screen: () =>
      Screen.Code({
        maybeFile: Option.none(),
        maybeLines: Option.none(),
        shown: WHOLE_TASK,
        taskId: aTask,
      }),
  });
  expect(update(onCode, Message.PressedEscape()).model).toStrictEqual(onCode);
});
