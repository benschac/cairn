import { PrdSectionId, Session, type SectionId } from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import { Array, Option, Record, Schema } from "effect";
import { Command, Mount, role, within } from "foldkit/scene";
import type { Document, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";

import { FocusSearchInput, ScrollSearchResult } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import type { Measured } from "../src/wires.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/message.ts";
import { TraceData, type Model } from "../src/model.ts";
import { FocusDetailHeading } from "../src/update.ts";
import { sectionTitleOf } from "../src/trace.ts";
import { view } from "../src/view/view.ts";

/** A fresh model holding the demo trace. */
export const loaded = modifyFields(init().model, {
  trace: () => TraceData.Success({ data: demoTrace }),
});

/**
 * The model with every stack's finished trunk unfolded, for a scene that looks at chips inside one
 * and has no use for the fold.
 */
export const unfolded = (model: Model): Model =>
  modifyFields(model, {
    reader: (reader) =>
      modifyFields(reader, {
        unfolded: () =>
          Record.fromIterableWith(stacksOf(demoTrace.tasks), (stack) => [stack.root, true]),
      }),
  });

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

/**
 * The reader's mounts, answering as they would on a page with no layout: the PRD pane found the
 * first section at its top, the stacks pane has no chart to measure and nothing is boxed.
 */
export const mounted = Mount.resolveAll(
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);

/** Leaving the reader ends its mounts; a scene has to acknowledge each. */
export const readerEnded = () => [
  Mount.expectEnded(TrackPrdScroll),
  Mount.expectEnded(ScrollStacksToBottom),
  Mount.expectEnded(MeasureWires),
];

/** Opening the detail panel, or changing its node, moves focus to its heading; the test answers for the focus. */
export const focusedDetailHeading = Command.resolve(
  FocusDetailHeading,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedFocusDetailHeading(),
);

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
