import type { SectionId, TaskId } from "@cairn/contract";
import { Array, Option } from "effect";
import { Command, Mount, role, within } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { PanZoomCanvas } from "../src/canvas.ts";
import { FocusDrawerHeading, FocusNode } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/message.ts";
import { TraceData } from "../src/model.ts";
import { sectionTitleOf } from "../src/trace.ts";

/** A fresh model holding the demo trace. */
export const loaded = modifyFields(init().model, {
  trace: () => TraceData.Success({ data: demoTrace }),
});

/** The size a scene gives the canvas pane. */
export const paneSize = { height: 600, width: 1200 };

/**
 * Scene tests run no hooks, so the canvas pane's mount stays pending until the test answers for
 * it with the message the library would send first.
 */
// oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
export const mounted = Mount.resolve(PanZoomCanvas, Message.MeasuredPane({ size: paneSize }));

/** Opening a drawer moves focus to its heading; the test answers for the focus. */
export const focusedDrawerHeading = Command.resolve(
  FocusDrawerHeading,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedFocusDrawerHeading(),
);

/** Closing a drawer moves focus back to its node's button; the test answers for the focus. */
// oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
export const focusedNode = Command.resolve(FocusNode, Message.CompletedFocusNode());

/** The button holding a section's title, in the PRD or the Spec column of the demo trace. */
export const sectionButton = (column: "PRD" | "Spec", id: SectionId) =>
  within(role("region", { name: column }), role("button", { name: sectionTitleOf(demoTrace, id) }));

/** The button holding a task's id and title, in the Stacks column of the demo trace. */
export const taskButton = (id: TaskId) =>
  within(
    role("region", { name: "Stacks" }),
    role("button", {
      name: `${id} ${Option.getOrThrow(Array.findFirst(demoTrace.tasks, (task) => task.id === id)).title}`,
    }),
  );
