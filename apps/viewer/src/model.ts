import { Participant, ParticipantId, Sha, Trace } from "@cairn/contract";
import { Option, Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

import { Positions, Size, Viewport } from "./geometry.ts";
import { Pin } from "./highlight.ts";
import { Node } from "./trace.ts";

/** The trace as it loads: nothing yet, a failure, the trace, or the last good trace beside a failure. */
export const TraceData = AsyncData.Schema(Schema.toType(Trace), Schema.String);
export type TraceData = typeof TraceData.schema.Type;

/**
 * The detail drawer: closed, or open on a node with the commit clicked in it. The open drawer is
 * the selection, so a commit cannot be chosen while the drawer is closed.
 */
export const Drawer = defineTaggedUnion({
  Closed: {},
  Open: { maybeCommitSha: Schema.Option(Sha), node: Node },
});
export type Drawer = typeof Drawer.Type;

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
  /** The pinned nodes, in the order they were pinned; each chain stays lit in its pin's colour. */
  pins: Schema.Array(Pin),
  positions: Positions,
  presenceConnection: PresenceConnection,
  trace: TraceData.schema,
  /** Where the canvas layer sits in its pane. */
  viewport: Viewport,
});
export type Model = typeof Model.Type;
