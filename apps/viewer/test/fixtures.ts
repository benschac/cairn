import { Session, type SectionId, type TaskId } from "@cairn/contract";
import { Array, Option, Schema, String } from "effect";
import { Command, Mount, role, within } from "foldkit/scene";
import type { Document, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";

import { PanZoomCanvas } from "../src/canvas.ts";
import {
  FocusDrawerHeading,
  FocusNode,
  FocusSearchInput,
  ScrollSearchResult,
} from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { DrawDiagram } from "../src/diagram.ts";
import type { Positions } from "../src/geometry.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import type { Measured } from "../src/wires.ts";
import { init } from "../src/init.ts";
import { MeasureLayout } from "../src/layout.ts";
import { Message } from "../src/message.ts";
import { TraceData, type Model } from "../src/model.ts";
import { FocusDetailHeading } from "../src/update.ts";
import { sectionTitleOf } from "../src/trace.ts";
import { taskHeadingOf } from "../src/view/stacksView.ts";
import { view } from "../src/view/view.ts";

/** A fresh model holding the demo trace. */
export const loaded = modifyFields(init().model, {
  trace: () => TraceData.Success({ data: demoTrace }),
});

/** The size a scene gives the canvas pane. */
export const paneSize = { height: 600, width: 1200 };

/**
 * How many Mermaid diagrams the demo's documents hold. The canvas mounts a `DrawDiagram` for each,
 * and a plan can add one to any spec section, so the scenes count them instead of assuming one.
 */
export const diagramCount = Array.length(
  Array.filter(
    Array.flatMap([demoTrace.prd.markdown, demoTrace.spec.markdown], String.split("\n")),
    (line) => String.trim(line) === "```mermaid",
  ),
);

/** Each diagram's mount answering, once it has drawn, with the layer measured at `positions`. */
const diagramsDrawnWith = (positions: Positions) =>
  Array.makeBy(
    diagramCount,
    // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
    () => [DrawDiagram, Message.MeasuredLayout({ positions })] as const,
  );

/**
 * Scene tests run no hooks, so the layer's mount stays pending until the test answers for it with
 * the message the mount would send first: the positions it measured. Each Mermaid diagram in the
 * spec has a mount too, which measures the layer once it has drawn, so it answers with the same.
 */
export const layerMountedWith = (positions: Positions) =>
  Mount.resolveAll(
    // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
    [MeasureLayout, Message.MeasuredLayout({ positions })],
    ...diagramsDrawnWith(positions),
  );

/** The layer's mount answering that no node is measured yet. */
export const layerMounted = layerMountedWith({});

/**
 * The canvas pane's mount stays pending until the test answers for it with the message the library
 * would send first. This also answers for the layer's mount, with the nodes measured at `positions`.
 */
export const mountedWith = (positions: Positions) =>
  Mount.resolveAll(
    // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
    [PanZoomCanvas, Message.MeasuredPane({ size: paneSize })],
    // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
    [MeasureLayout, Message.MeasuredLayout({ positions })],
    ...diagramsDrawnWith(positions),
  );

/** Leaving the canvas ends its mounts; a scene has to acknowledge each. */
export const canvasEnded = () =>
  Array.appendAll(
    [Mount.expectEnded(PanZoomCanvas), Mount.expectEnded(MeasureLayout)],
    Array.makeBy(diagramCount, () => Mount.expectEnded(DrawDiagram)),
  );

/** The pane sized and nothing measured. */
export const mounted = mountedWith({});

/** What the reader's mount measures on a page with no layout: every pane empty and no wire end boxed. */
export const unmeasuredWires: Measured = {
  boxes: {},
  panes: {
    prd: { height: 0, width: 0, x: 0, y: 0 },
    spec: { height: 0, width: 0, x: 0, y: 0 },
    stacks: { height: 0, width: 0, x: 0, y: 0 },
  },
};

/** The reader body's mount, answering with what it measured: a Scene has no hooks, so the test says. */
export const wiresMountedWith = (measured: Measured) =>
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Mount.resolve(MeasureWires, Message.MeasuredWires({ measured }));

/** The reader body's mount answering that nothing is measured. */
export const wiresMounted = wiresMountedWith(unmeasuredWires);

/** Opening a drawer moves focus to its heading; the test answers for the focus. */
export const focusedDrawerHeading = Command.resolve(
  FocusDrawerHeading,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedFocusDrawerHeading(),
);

/** Opening the detail panel, or changing its node, moves focus to its heading; the test answers for the focus. */
export const focusedDetailHeading = Command.resolve(
  FocusDetailHeading,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedFocusDetailHeading(),
);

/** Closing a drawer moves focus back to its node's button; the test answers for the focus. */
// oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
export const focusedNode = Command.resolve(FocusNode, Message.CompletedFocusNode());

/** Moving the active search result scrolls the list to it; the test answers for the scroll. */
export const scrolledSearchResult = Command.resolve(
  ScrollSearchResult,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedScrollSearchResult(),
);

/** Clicking a search result takes focus from the input, so it is moved back; the test answers for it. */
export const focusedSearchInput = Command.resolve(
  FocusSearchInput,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedFocusSearchInput(),
);

/**
 * `Lazy.expectAllReused` renders twice with the same Model; this view hands each render the next
 * Model of a sequence, so the second render is one frame later.
 */
export const sequence = (models: ReadonlyArray<Model>) => {
  let render = 0;
  return (_model: Model, h: HtmlBuilder<Message>): Document => {
    const model = Option.getOrThrow(Array.get(models, render % models.length));
    render += 1;
    return view(model, h);
  };
};

/** The button holding a section's title, in the PRD or the Spec column of the demo trace. */
export const sectionButton = (column: "PRD" | "Spec", id: SectionId) =>
  within(role("region", { name: column }), role("button", { name: sectionTitleOf(demoTrace, id) }));

/** The button holding a task's heading and title, in the Stacks column of the demo trace. */
export const taskButton = (id: TaskId) => {
  const task = Option.getOrThrow(
    Array.findFirst(demoTrace.tasks, (candidate) => candidate.id === id),
  );
  return within(
    role("region", { name: "Stacks" }),
    role("button", { name: `${taskHeadingOf(demoTrace, task)} ${task.title}` }),
  );
};

/** A session with one prompt, a reply and a tool turn, for the commit whose `Cairn-Session` is `id`. */
export const sessionWith = (id: string): Session =>
  Schema.decodeUnknownSync(Session)({
    format: "claude-code",
    id,
    notes: [],
    redactions: {},
    skipped: 0,
    taskId: "t1",
    turns: [
      { at: "2026-11-25T10:00:00.000Z", id: "p1", kind: "prompt", text: "Add the pane." },
      { at: "2026-11-25T10:00:01.000Z", id: "r1", kind: "reply", text: "Done." },
      {
        at: "2026-11-25T10:00:02.000Z",
        edits: [],
        failed: false,
        id: "c1",
        input: "ls",
        kind: "tool",
        name: "Bash",
        output: "a.ts",
        target: null,
      },
    ],
    version: 1,
  });
