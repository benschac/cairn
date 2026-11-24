import { Presence, PrdSectionId, SectionId, Sha, TaskId, Trace } from "@cairn/contract";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { ArrowKey, ClientPoint, Movable, PointerId } from "./drag.ts";
import { Positions, Size, Viewport } from "./geometry.ts";
import { Density, Destination, DiffStyle } from "./model.ts";
import { DividerKey, Pane } from "./panes.ts";
import { Node } from "./trace.ts";
import { Measured } from "./wires.ts";

export const Message = defineMessageUnion({
  /** The code view's "Back to canvas" button. */
  ClickedBackToCanvas: {},
  /** One of the diff style toggle's two buttons. */
  ClickedDiffStyle: { style: DiffStyle },
  /** A spec card's header: opens or closes that card alone. */
  ClickedCardHeader: { id: SectionId },
  /** One of the spec cards' density control's three buttons: it sets every card. */
  ClickedDensity: { density: Density },
  /** The drawer's Close button. */
  ClickedCloseDrawer: {},
  /** A task listed in a section's drawer. */
  ClickedDrawerTask: { id: TaskId },
  ClickedFit: {},
  /** The top bar's models and reasoning switch: shows or hides them everywhere. */
  ClickedModelsSwitch: {},
  /** Clears every pin. */
  ClickedClearPins: {},
  /** Anywhere on a node, or its title button: pins or unpins it. */
  ClickedNode: { node: Node },
  /** "Open code" on a task in the drawer, or a commit listed there: the code view on that task. */
  ClickedOpenCode: { id: TaskId, maybeSha: Schema.Option(Sha) },
  /** A click on a move handle, which stops there so it never reaches the node it sits on. */
  ClickedMoveHandle: {},
  /** The button that puts every moved document and task card back where the layout put it. */
  ClickedResetLayout: {},
  /** A PRD heading's section ID, small beside its title: copies the ID. */
  ClickedSectionId: { id: PrdSectionId },
  /** The top bar's "Plan" and "Canvas" buttons. */
  ClickedScreen: { screen: Destination },
  /** The status line under a PRD heading: pins that section, or unpins it when it is the pinned one. */
  ClickedStatusLine: { id: PrdSectionId },
  /** A result in the search list: it becomes the active result and is brought into view. */
  ClickedSearchResult: { node: Node },
  /** A task row in a spec card: opens the task's detail. */
  ClickedTask: { id: TaskId },
  /** A commit in the code view's tree. */
  ClickedTreeCommit: { sha: Sha },
  /** A file in the code view's tree. */
  ClickedTreeFile: { path: Schema.String },
  /** A task in the code view's tree. */
  ClickedTreeTask: { id: TaskId },
  /** The toggle that draws every curve, or only the active chain's. */
  ClickedShowAllCurves: {},
  /** The search input's text changed. */
  ChangedSearchQuery: { query: Schema.String },
  /** The presence socket closed or failed. */
  ClosedPresence: {},
  /** The clipboard took the section's ID, or refused it. */
  CompletedCopySectionId: { id: PrdSectionId, isCopied: Schema.Boolean },
  CompletedFocusDrawerHeading: {},
  CompletedFocusNode: {},
  CompletedFocusSearchInput: {},
  CompletedScrollSearchResult: {},
  /** The stacks pane was scrolled to the base branch bar at its bottom. */
  CompletedScrollStacks: {},
  /** The diff mount parsed the patch and drew it, or put the reason it could not in the pane. */
  CompletedRenderDiff: {},
  /** The canvas mount could not start pan and zoom. */
  FailedPanZoomCanvas: { reason: Schema.String },
  HoveredNode: { node: Node },
  LeftNode: {},
  MeasuredLayout: { positions: Positions },
  /** A pointer moved anywhere on the page while a drag was in progress, with the buttons it held. */
  MovedDragPointer: { buttons: Schema.Int, pointer: ClientPoint, pointerId: PointerId },
  /** The reader's mount measured every `data-wire` element and the three panes, in window coordinates. */
  MeasuredWires: { measured: Measured },
  /** The canvas mount measured the pane. */
  MeasuredPane: { size: Size },
  /**
   * A pointer or a key went down during a drag gesture. A primary pointer going down means every
   * earlier pointer is up, so a drag still in progress missed its release.
   */
  PressedAfterDrag: { isPrimaryPointer: Schema.Boolean },
  /** Escape went down on the page and nothing handled it first. */
  PressedEscape: {},
  /** In the search input: down to the next result. */
  PressedSearchArrowDown: {},
  /** In the search input: up to the previous result. */
  PressedSearchArrowUp: {},
  /** In the search input: selects the active result. */
  PressedSearchEnter: {},
  /** In the search input: clears the search. */
  PressedSearchEscape: {},
  /** An arrow key went down on a focused divider. */
  PressedArrowOnDivider: { key: DividerKey, pane: Pane },
  /** The primary button or a touch went down on a divider. */
  PressedDivider: {
    maybeWidth: Schema.Option(Schema.Finite), // the pane as rendered; none when it could not be read
    pane: Pane,
    pointerId: PointerId,
    x: Schema.Finite,
  },
  /** A pointer moved anywhere on the page while a divider was being dragged, with the buttons it held. */
  MovedResizePointer: { buttons: Schema.Int, pointerId: PointerId, x: Schema.Finite },
  /** A pointer went up or was cancelled anywhere on the page while a divider was being dragged. */
  ReleasedResizePointer: { pointerId: PointerId },
  /** An arrow key went down on a move handle. */
  PressedArrowOnMoveHandle: { key: ArrowKey, movable: Movable },
  /** The primary button or a touch went down on a move handle. */
  PressedMoveHandle: { movable: Movable, pointer: ClientPoint, pointerId: PointerId },
  /** The presence socket opened. */
  OpenedPresence: {},
  /** The canvas mount reports each pan and zoom. */
  PannedOrZoomed: { viewport: Viewport },
  /** A patch route's text, or why it could not be fetched. */
  ReceivedPatch: { path: Schema.String, result: Schema.Result(Schema.String, Schema.String) },
  ReceivedPresence: { presence: Presence },
  /** A pointer went up or was cancelled anywhere on the page while a drag was in progress. */
  ReleasedDragPointer: { pointerId: PointerId },
  /** The section at the top of the PRD pane changed. */
  ScrolledPrd: { id: PrdSectionId },
  /** The click from a drag's release was stopped before it reached any node. */
  SuppressedClickAfterDrag: {},
  SettledLoadTrace: { result: Schema.Result(Schema.toType(Trace), Schema.String) },
});
export type Message = typeof Message.Type;
