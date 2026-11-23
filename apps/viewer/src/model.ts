import { Participant, ParticipantId, Sha, Trace } from "@cairn/contract";
import { Option, Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

import { DragState, Offsets } from "./drag.ts";
import { Positions, Size, Viewport } from "./geometry.ts";
import { Pin } from "./highlight.ts";
import { Search } from "./search.ts";
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
  /** The document or task card being dragged by its handle, if any. */
  drag: DragState,
  drawer: Drawer,
  /** Every curve is drawn, not only the active chain's. Off at first, so the canvas starts clear. */
  isShowingAllCurves: Schema.Boolean,
  /**
   * A selected search result the canvas has yet to centre on, because its node or the pane is not
   * measured. It centres on the first measurement that has both, and is dropped with the result.
   */
  maybeCentring: Schema.Option(Node),
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
  /** This window's search. It is never shared and changes nothing but how this window looks. */
  search: Search,
  trace: TraceData.schema,
  /** How far each moved document and task card sits from where the layout put it. Not kept across reloads. */
  offsets: Offsets,
  /** Where the canvas layer sits in its pane. */
  viewport: Viewport,
});
export type Model = typeof Model.Type;
