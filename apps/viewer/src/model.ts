import {
  LinesStep,
  Link,
  Participant,
  ParticipantId,
  PassageStep,
  PrdSectionId,
  SectionId,
  SegmentStep,
  Session,
  Sha,
  StackStep,
  TaskId,
  Trace,
} from "@cairn/contract";
import { UiSchema } from "@effect/ui";
import { Option, Result, Schema } from "effect";

import { Resize, Widths } from "./panes.ts";
import { SectionReader } from "./readers.ts";
import { SearchState } from "./search.ts";
import { Node } from "./trace.ts";
import { Measured } from "./wires.ts";

/** The trace as it loads: nothing yet, a failure, the trace, or the last good trace beside a failure. */
export const TraceData = UiSchema.TaggedEnum({
  Loading: {},
  Failure: { error: Schema.String },
  Stale: { data: Schema.toType(Trace), error: Schema.String },
  Success: { data: Schema.toType(Trace) },
});
export type TraceData = typeof TraceData.Type;

/** The trace a `TraceData` holds: the loaded one, or the last good one beside a failure. */
export const loadedTraceOf = (data: TraceData): Option.Option<Trace> =>
  TraceData.match(data, {
    Failure: () => Option.none(),
    Loading: () => Option.none(),
    Stale: ({ data: trace }) => Option.some(trace),
    Success: ({ data: trace }) => Option.some(trace),
  });

/**
 * A load's result folded into what was there: a trace is the new `Success`, and a failure keeps
 * the last good trace beside it as `Stale`, or is a bare `Failure` when there was none.
 */
export const settledTrace =
  (result: Result.Result<Trace, string>) =>
  (data: TraceData): TraceData =>
    Result.match(result, {
      onFailure: (error) =>
        Option.match(loadedTraceOf(data), {
          onNone: () => TraceData.Failure({ error }),
          onSome: (trace) => TraceData.Stale({ data: trace, error }),
        }),
      onSuccess: (trace) => TraceData.Success({ data: trace }),
    });

/**
 * What the code view shows of its task: the whole stacked diff, or one of its commits. The whole
 * diff runs to `maybeHead`, one of the task's commits, which a link can name; none is its newest.
 */
export const Shown = UiSchema.TaggedEnum({
  OneCommit: { sha: Sha },
  WholeTask: { maybeHead: Schema.Option(Sha) },
});
export type Shown = typeof Shown.Type;

/** A task's whole diff, to its newest commit: what a click on a task opens. */
export const WHOLE_TASK: Shown = Shown.WholeTask({ maybeHead: Option.none() });

/** How the code view lays a diff out: one column, or the old and new side by side. */
export const DiffStyle = Schema.Literals(["unified", "split"]);
export type DiffStyle = typeof DiffStyle.Type;

/** A patch route's text as it loads: on its way, refused or unreachable with why, or here. */
export const PatchData = UiSchema.TaggedEnum({
  Failed: { message: Schema.String },
  Loaded: { text: Schema.String },
  Loading: {},
});
export type PatchData = typeof PatchData.Type;

/** A session route's `Session` as it loads: on its way, refused or unreachable with why, or here. */
export const SessionData = UiSchema.TaggedEnum({
  Failed: { message: Schema.String },
  Loaded: { session: Schema.toType(Session) },
  Loading: {},
});
export type SessionData = typeof SessionData.Type;

/**
 * The tool turn whose hunks the diff marks as active, and the pane it was chosen from: a hunk's
 * mark in the diff, or the turn's line in the session pane. Only a choice from the session pane
 * scrolls the diff.
 */
export const HighlightedTurn = Schema.Struct({
  from: Schema.Literals(["diff", "session"]),
  id: Schema.String,
});
export type HighlightedTurn = typeof HighlightedTurn.Type;

/**
 * Text selected inside one section's passage, as the subscription reads it: the quote is the
 * selection's text with its whitespace collapsed, and may be too long to link.
 */
export const PassageSelection = Schema.Struct({ quote: Schema.String, section: SectionId });
export type PassageSelection = typeof PassageSelection.Type;

/**
 * The screen: the reader (the plan screen), or the code view on a task with what is shown of it,
 * the file selected in it and the lines a link selected in that file. Everything the reader needs
 * stays in the model while the code view is open.
 */
export const Screen = UiSchema.TaggedEnum({
  Reader: {},
  Code: {
    maybeFile: Schema.Option(Schema.String),
    maybeLines: Schema.Option(LinesStep),
    shown: Shown,
    taskId: TaskId,
  },
});
export type Screen = typeof Screen.Type;
export type CodeScreen = Extract<Screen, { readonly _tag: "Code" }>;

/** What a link focuses in the stacks pane: the stack a task starts, or its finished trunk. */
export const Focus = Schema.Union([StackStep, SegmentStep]);
export type Focus = typeof Focus.Type;

/** How much of every spec card shows: the titles, the summaries, or the full sections. */
export const Density = Schema.Literals(["titles", "summary", "full"]);
export type Density = typeof Density.Type;

/**
 * What a person chose in the reader (see spec.viewer.reader). The section at the top of the PRD
 * pane is measured, but it is kept here with the pin because the current section is decided
 * from the two.
 */
export const Reader = Schema.Struct({
  /** The section at the top of the PRD pane, once it is measured. */
  maybeAtTop: Schema.Option(PrdSectionId),
  /** The section or item whose status line or annotation was clicked; it stays current while the PRD scrolls. */
  maybePinned: Schema.Option(PrdSectionId),
  /** The section or item a spec card's chip named; it is marked until the next click or hover elsewhere. */
  maybeMarked: Schema.Option(PrdSectionId),
  /** The passage a link opened, in a PRD or a spec section; the panes mark it. */
  maybePassage: Schema.Option(PassageStep),
  /** The stack or finished trunk a link opened; the stacks pane outlines it. */
  maybeFocus: Schema.Option(Focus),
  /** How much of every spec card shows. */
  density: Density,
  /** The finished trunks opened, by the root of their stack. A trunk not named here is folded. */
  unfolded: Schema.Record(TaskId, Schema.Boolean),
  /** The cards opened or closed on their own, apart from the density. */
  opened: Schema.Record(SectionId, Schema.Boolean),
  /** The PRD pane shows its headings without their prose. Off at first. */
  isPrdCondensed: Schema.Boolean,
  /** The PRD sections opened or closed on their own, apart from the condensed switch. */
  prdOpened: Schema.Record(SectionId, Schema.Boolean),
});
export type Reader = typeof Reader.Type;

/** The presence socket: opening, open, or closed or failed; a closed socket is not reopened. */
export const PresenceConnection = UiSchema.TaggedEnum({
  Connected: {},
  Connecting: {},
  Disconnected: {},
});
export type PresenceConnection = typeof PresenceConnection.Type;

export const Model = Schema.Struct({
  /** The diff style the code view draws diffs in. */
  diffStyle: DiffStyle,
  /** The detail panel's trail: empty is a closed panel, and the last node is the one shown. */
  detail: Schema.Array(Node),
  /** The models and reasoning switch: every model chip, mark and square shows. On at first. */
  isShowingModels: Schema.Boolean,
  /** The section whose ID was just copied; its button reads "copied" until another reader click. */
  maybeCopied: Schema.Option(PrdSectionId),
  /** The path of the link just copied; the button that copies it reads "copied" until the next reader click. */
  maybeCopiedLink: Schema.Option(Schema.String),
  /** What the last link that opened left out, or why the address was not a link, until dismissed. */
  maybeLinkNotice: Schema.Option(Schema.String),
  /** The text selected inside a PRD or spec section's passage, when there is some. */
  maybeSelectedPassage: Schema.Option(PassageSelection),
  /** A link waiting for the first trace, or for a patch or a session its steps read. */
  maybePendingLink: Schema.Option(Link),
  maybeHovered: Schema.Option(Node),
  /** What the reader's mount last measured for its curves; none until the three panes are in the page. */
  maybeMeasuredWires: Schema.Option(Measured),
  maybeYou: Schema.Option(ParticipantId),
  participants: Schema.Array(Participant),
  /** Who else is reading which section: what the PRD pane draws of the room, kept the same reference until it changes. */
  readers: Schema.Array(SectionReader),
  /** The patches the code view has asked for, by route path. A loaded one is never fetched again. */
  patches: Schema.Record(Schema.String, PatchData),
  /** The sessions the code view has asked for, by session ID. A loaded one is never fetched again. */
  sessions: Schema.Record(Schema.String, SessionData),
  /** The tool turns a person opened, by turn ID. */
  openedTurns: Schema.Record(Schema.String, Schema.Boolean),
  /** The tool turns whose input and output a person asked to see whole, by turn ID. */
  fullTurns: Schema.Record(Schema.String, Schema.Boolean),
  /** The turn whose hunks the diff marks, if a person chose one from either side. */
  maybeHighlightedTurn: Schema.Option(HighlightedTurn),
  presenceConnection: PresenceConnection,
  /** What a person chose in the reader. */
  reader: Reader,
  /** A divider being dragged, if any. */
  resize: Resize,
  /** This window's search. Private to it: it changes no document, status or other window. */
  search: SearchState,
  /** The reader or the code view. */
  screen: Screen,
  trace: TraceData,
  /** What a person chose for each pane, in pixels. Not kept across reloads. */
  widths: Widths,
  /**
   * Whether a person has moved the stacks pane's divider. Until they do, the pane takes the width
   * its chart was measured at.
   */
  hasChosenStacksWidth: Schema.Boolean,
});
export type Model = typeof Model.Type;
