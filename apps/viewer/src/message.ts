import { Presence, Sha, TaskId, Trace } from "@cairn/contract";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { ArrowKey, ClientPoint, Movable, PointerId } from "./drag.ts";
import { Positions, Size, Viewport } from "./geometry.ts";
import { Node } from "./trace.ts";

export const Message = defineMessageUnion({
  /** The drawer's Close button. */
  ClickedCloseDrawer: {},
  ClickedCommit: { sha: Sha },
  /** A task listed in a section's drawer. */
  ClickedDrawerTask: { id: TaskId },
  ClickedFit: {},
  /** Clears every pin. */
  ClickedClearPins: {},
  /** A result in the search list, by pointer: selects it as Enter does. */
  ClickedSearchResult: { node: Node },
  /** Anywhere on a node, or its title button: pins or unpins it. */
  ClickedNode: { node: Node },
  /** A click on a move handle, which stops there so it never reaches the node it sits on. */
  ClickedMoveHandle: {},
  /** The button that puts every moved document and task card back where the layout put it. */
  ClickedResetLayout: {},
  /** The toggle that draws every curve, or only the active chain's. */
  ClickedShowAllCurves: {},
  /** The presence socket closed or failed. */
  ClosedPresence: {},
  CompletedFocusDrawerHeading: {},
  CompletedFocusNode: {},
  /** Focus went back to the search input after a result was clicked. */
  CompletedFocusSearch: {},
  /** The active search result was scrolled into view in the result list. */
  CompletedScrollSearchResult: {},
  /** The search input's text changed, by typing, pasting or its own clear control. */
  EditedSearchQuery: { query: Schema.String },
  /** The canvas mount could not start pan and zoom. */
  FailedPanZoomCanvas: { reason: Schema.String },
  HoveredNode: { node: Node },
  LeftNode: {},
  MeasuredLayout: { positions: Positions },
  /** A pointer moved anywhere on the page while a drag was in progress, with the buttons it held. */
  MovedDragPointer: { buttons: Schema.Int, pointer: ClientPoint, pointerId: PointerId },
  /** The canvas mount measured the pane. */
  MeasuredPane: { size: Size },
  /**
   * A pointer or a key went down during a drag gesture. A primary pointer going down means every
   * earlier pointer is up, so a drag still in progress missed its release.
   */
  PressedAfterDrag: { isPrimaryPointer: Schema.Boolean },
  /** Down arrow in the search input: the next result. */
  PressedSearchArrowDown: {},
  /** Up arrow in the search input: the previous result. */
  PressedSearchArrowUp: {},
  /** Enter in the search input: selects the active result. */
  PressedSearchEnter: {},
  /** Escape in the search input: clears the search. */
  PressedSearchEscape: {},
  /** An arrow key went down on a move handle. */
  PressedArrowOnMoveHandle: { key: ArrowKey, movable: Movable },
  /** The primary button or a touch went down on a move handle. */
  PressedMoveHandle: { movable: Movable, pointer: ClientPoint, pointerId: PointerId },
  /** The presence socket opened. */
  OpenedPresence: {},
  /** The canvas mount reports each pan and zoom. */
  PannedOrZoomed: { viewport: Viewport },
  ReceivedPresence: { presence: Presence },
  /** A pointer went up or was cancelled anywhere on the page while a drag was in progress. */
  ReleasedDragPointer: { pointerId: PointerId },
  /** The click from a drag's release was stopped before it reached any node. */
  SuppressedClickAfterDrag: {},
  SettledLoadTrace: { result: Schema.Result(Schema.toType(Trace), Schema.String) },
});
export type Message = typeof Message.Type;
