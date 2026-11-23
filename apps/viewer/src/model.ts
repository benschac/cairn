import { Participant, ParticipantId, Sha, TaskId, Trace } from "@cairn/contract";
import { Option, Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

import { DragState, Offsets } from "./drag.ts";
import { Positions, Size, Viewport } from "./geometry.ts";
import { Pin } from "./highlight.ts";
import { Node } from "./trace.ts";

/** The trace as it loads: nothing yet, a failure, the trace, or the last good trace beside a failure. */
export const TraceData = AsyncData.Schema(Schema.toType(Trace), Schema.String);
export type TraceData = typeof TraceData.schema.Type;

/**
 * The detail drawer: closed, or open on a node. The open drawer is the selection.
 */
export const Drawer = defineTaggedUnion({
  Closed: {},
  Open: { node: Node },
});
export type Drawer = typeof Drawer.Type;

/** What the code view shows of its task: the whole stacked diff, or one of its commits. */
export const Shown = defineTaggedUnion({
  OneCommit: { sha: Sha },
  WholeTask: {},
});
export type Shown = typeof Shown.Type;

/** How the code view lays a diff out: one column, or the old and new side by side. */
export const DiffStyle = Schema.Literals(["unified", "split"]);
export type DiffStyle = typeof DiffStyle.Type;

/** A patch route's text as it loads: on its way, refused or unreachable with why, or here. */
export const PatchData = defineTaggedUnion({
  Failed: { message: Schema.String },
  Loaded: { text: Schema.String },
  Loading: {},
});
export type PatchData = typeof PatchData.Type;

/**
 * The screen: the canvas, or the code view on a task with what is shown of it and the file
 * selected in it. Everything the canvas needs stays in the model while the code view is open.
 */
export const Screen = defineTaggedUnion({
  Canvas: {},
  Code: { maybeFile: Schema.Option(Schema.String), shown: Shown, taskId: TaskId },
});
export type Screen = typeof Screen.Type;
export type CodeScreen = Extract<Screen, { readonly _tag: "Code" }>;

/** The node whose drawer is open: the selected node. */
export const selectedNodeOf = (drawer: Drawer): Option.Option<Node> =>
  Drawer.match(drawer, {
    Closed: () => Option.none(),
    Open: ({ node }) => Option.some(node),
  });

/** The presence socket: opening, open, or closed or failed; a closed socket is not reopened. */
export const PresenceConnection = defineTaggedUnion({
  Connected: {},
  Connecting: {},
  Disconnected: {},
});
export type PresenceConnection = typeof PresenceConnection.Type;

export const Model = Schema.Struct({
  /** The diff style the code view draws diffs in. */
  diffStyle: DiffStyle,
  /** The document or task card being dragged by its handle, if any. */
  drag: DragState,
  drawer: Drawer,
  /** Every curve is drawn, not only the active chain's. Off at first, so the canvas starts clear. */
  isShowingAllCurves: Schema.Boolean,
  maybeHovered: Schema.Option(Node),
  /** The canvas pane's size, once its mount has measured it. */
  maybePaneSize: Schema.Option(Size),
  /** Why pan and zoom did not start on the canvas pane; none while it works. */
  maybePanZoomFailure: Schema.Option(Schema.String),
  maybeYou: Schema.Option(ParticipantId),
  participants: Schema.Array(Participant),
  /** The patches the code view has asked for, by route path. A loaded one is never fetched again. */
  patches: Schema.Record(Schema.String, PatchData),
  /** The pinned nodes, in the order they were pinned; each chain stays lit in its pin's colour. */
  pins: Schema.Array(Pin),
  positions: Positions,
  presenceConnection: PresenceConnection,
  /** The canvas or the code view. */
  screen: Screen,
  trace: TraceData.schema,
  /** How far each moved document and task card sits from where the layout put it. Not kept across reloads. */
  offsets: Offsets,
  /** Where the canvas layer sits in its pane. */
  viewport: Viewport,
});
export type Model = typeof Model.Type;
