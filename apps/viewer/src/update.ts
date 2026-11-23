import { Array, Boolean, Effect, Option, Record, Schema } from "effect";
import { AsyncData, Command } from "foldkit";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import {
  TOOLBAR_MARGIN,
  TOOLBAR_WIDTH,
  boundsOf,
  centerViewport,
  fitViewport,
  type Insets,
} from "./canvas.ts";
import { FocusDrawerHeading, FocusNode, FocusSearchInput, ScrollSearchResult } from "./command.ts";
import { DragState, canvasDeltaOf, moveBy, nudgeOf } from "./drag.ts";
import { DRAWER_WIDTH } from "./drawer.ts";
import { isPinned, pin, togglePin } from "./highlight.ts";
import { describeTraceError, loadDemoTrace } from "./load.ts";
import { Message } from "./message.ts";
import { Drawer, PresenceConnection, selectedNodeOf, type Model } from "./model.ts";
import { NO_SEARCH, chosen, moved, queried, refreshed, type SearchState } from "./search.ts";
import { Node } from "./trace.ts";

// UPDATE

const nodeEquivalence = Schema.toEquivalence(Node);

const openOn = (node: Node): Drawer => Drawer.Open({ maybeCommitSha: Option.none(), node });

/** The drag this pointer is making; none while nothing is dragged or another pointer drags. */
const dragByPointer = (drag: DragState, pointerId: number) =>
  Option.filter(
    Option.liftPredicate(drag, DragState.guards.Dragging),
    (dragging) => dragging.pointerId === pointerId,
  );

/** A drag that has just ended is over; any other drag state stays as it is. */
const idleAfterRelease = (model: Model): Model =>
  DragState.guards.Released(model.drag)
    ? modifyFields(model, { drag: () => DragState.Idle() })
    : model;

/** What covers the pane's edges: the toolbar on the left, and the drawer on the right while it is open. */
const insetsOf = (drawer: Drawer): Insets => ({
  left: TOOLBAR_MARGIN + TOOLBAR_WIDTH,
  right: Drawer.match(drawer, { Closed: () => 0, Open: () => DRAWER_WIDTH }),
});

/**
 * Brings the result waiting to be seen into the middle of what the pane shows, at the zoom it has.
 * Until layout has measured the node and the pane its size, it keeps waiting; the measurements
 * include a moved card's offset.
 */
const centeredOnSearch = (model: Model): Model =>
  Option.match(
    Option.flatMap(
      Option.all({ node: model.search.maybeToCenter, pane: model.maybePaneSize }),
      ({ node, pane }) =>
        Option.map(Record.get(model.positions, node.id), (rect) =>
          centerViewport(rect, model.viewport, pane, insetsOf(model.drawer)),
        ),
    ),
    {
      onNone: () => model,
      onSome: (viewport) =>
        modifyFields(model, {
          search: (search) => modifyFields(search, { maybeToCenter: () => Option.none() }),
          viewport: () => viewport,
        }),
    },
  );

/** A result chosen by Enter or a click: it is active, and the canvas moves to it. */
const selectedResult = (model: Model, node: Node) => ({
  model: centeredOnSearch(modifyFields(model, { search: (search) => chosen(search, node) })),
});

/** The model with this search, and the list scrolled to its active result so it is not offscreen. */
const searchedWith = (model: Model, search: SearchState) => ({
  commands: Array.map(Array.fromOption(search.maybeActive), (node) => ScrollSearchResult({ node })),
  model: modifyFields(model, { search: () => search }),
});

/** No buttons held: the pointer is up, whether or not its release was heard. */
const NO_BUTTONS = 0;

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    // Closing the drawer returns focus to the button of the node it was open on.
    ClickedCloseDrawer: () =>
      Drawer.match(model.drawer, {
        Closed: () => ({ model }),
        Open: ({ node }) => ({
          commands: [FocusNode({ node })],
          model: modifyFields(model, { drawer: () => Drawer.Closed() }),
        }),
      }),
    // A commit is clicked in the open drawer; with the drawer closed there is none to click.
    ClickedCommit: ({ sha }) => ({
      model: Drawer.match(model.drawer, {
        Closed: () => model,
        Open: ({ node }) =>
          modifyFields(model, {
            drawer: () => Drawer.Open({ maybeCommitSha: Option.some(sha), node }),
          }),
      }),
    }),
    // A task in a section's drawer opens that task's drawer and pins it; it never closes a drawer
    // or unpins a task.
    ClickedClearPins: () => ({ model: modifyFields(model, { pins: () => [] }) }),
    ClickedDrawerTask: ({ id }) => ({
      commands: [FocusDrawerHeading()],
      model: modifyFields(model, {
        drawer: () => openOn({ id, kind: "task" }),
        pins: (pins) => pin(pins, { id, kind: "task" }),
      }),
    }),
    // Fit frames every measured node in the pane; until both are known it does nothing.
    ClickedFit: () =>
      Option.match(Option.all({ bounds: boundsOf(model.positions), pane: model.maybePaneSize }), {
        onNone: () => ({ model }),
        onSome: ({ bounds, pane }) => ({
          model: modifyFields(model, {
            viewport: () => fitViewport(bounds, pane.width, pane.height),
          }),
        }),
      }),
    // Clicking a node pins its chain in the next free colour, opens the node's drawer and moves
    // focus to its heading. Clicking a pinned node unpins it, and closes the drawer if the drawer
    // is open on it; a drawer open on another node stays.
    ClickedNode: ({ node }) =>
      isPinned(model.pins, node)
        ? {
            model: modifyFields(model, {
              drawer: (drawer) =>
                Option.exists(selectedNodeOf(drawer), (selected) => nodeEquivalence(selected, node))
                  ? Drawer.Closed()
                  : drawer,
              pins: (pins) => togglePin(pins, node),
            }),
          }
        : {
            commands: [FocusDrawerHeading()],
            model: modifyFields(model, {
              drawer: () => openOn(node),
              pins: (pins) => togglePin(pins, node),
            }),
          },
    ClickedMoveHandle: () => ({ model }),
    ClickedResetLayout: () => ({ model: modifyFields(model, { offsets: () => ({}) }) }),
    // A click takes focus from the input, so it goes back: the keyboard stays in search.
    ClickedSearchResult: ({ node }) => ({
      ...selectedResult(model, node),
      commands: [FocusSearchInput()],
    }),
    ClickedShowAllCurves: () => ({
      model: modifyFields(model, { isShowingAllCurves: Boolean.not }),
    }),
    // The room is unknown once the socket is gone, so nobody is shown and you are no one.
    // A new query makes the first result active, so the list goes back to it.
    ChangedSearchQuery: ({ query }) =>
      searchedWith(model, queried(model.search, AsyncData.getData(model.trace), query)),
    ClosedPresence: () => ({
      model: modifyFields(model, {
        maybeYou: () => Option.none(),
        participants: () => [],
        presenceConnection: () => PresenceConnection.Disconnected(),
      }),
    }),
    CompletedFocusDrawerHeading: () => ({ model }),
    CompletedFocusNode: () => ({ model }),
    CompletedFocusSearchInput: () => ({ model }),
    CompletedScrollSearchResult: () => ({ model }),
    FailedPanZoomCanvas: ({ reason }) => ({
      model: modifyFields(model, { maybePanZoomFailure: () => Option.some(reason) }),
    }),
    HoveredNode: ({ node }) => ({
      model: modifyFields(model, { maybeHovered: () => Option.some(node) }),
    }),
    LeftNode: () => ({ model: modifyFields(model, { maybeHovered: () => Option.none() }) }),
    MeasuredLayout: ({ positions }) => ({
      model: centeredOnSearch(modifyFields(model, { positions: () => positions })),
    }),
    // The pointer's move since it was last seen, in canvas units at the current zoom, so the item
    // stays under the pointer however far the canvas is zoomed.
    // A move with no button held means the release was missed, for example on a click too quick
    // for the page listener to start before it; the drag ends there instead of following the
    // pointer. Its click has already happened, so there is nothing to stop and the drag is idle.
    MovedDragPointer: ({ buttons, pointer, pointerId }) => ({
      model: Option.match(dragByPointer(model.drag, pointerId), {
        onNone: () => model,
        onSome: (dragging) =>
          buttons === NO_BUTTONS
            ? modifyFields(model, { drag: () => DragState.Idle() })
            : modifyFields(model, {
                drag: () => DragState.Dragging({ movable: dragging.movable, pointer, pointerId }),
                offsets: moveBy(
                  dragging.movable,
                  canvasDeltaOf(dragging.pointer, pointer, model.viewport.zoom),
                ),
              }),
      }),
    }),
    MeasuredPane: ({ size }) => ({
      model: centeredOnSearch(modifyFields(model, { maybePaneSize: () => Option.some(size) })),
    }),
    OpenedPresence: () => ({
      model: modifyFields(model, { presenceConnection: () => PresenceConnection.Connected() }),
    }),
    // A press ends a released drag. A primary pointer going down also ends a drag still in
    // progress: it means every earlier pointer is up, so that drag's release was missed. A second
    // finger is not primary and leaves the drag alone.
    PressedAfterDrag: ({ isPrimaryPointer }) => ({
      model:
        isPrimaryPointer && DragState.guards.Dragging(model.drag)
          ? modifyFields(model, { drag: () => DragState.Idle() })
          : idleAfterRelease(model),
    }),
    PressedArrowOnMoveHandle: ({ key, movable }) => ({
      model: modifyFields(model, { offsets: moveBy(movable, nudgeOf(key)) }),
    }),
    // One drag at a time: a press on another handle while one is in progress is ignored, so a
    // second finger cannot take the drag over.
    PressedMoveHandle: ({ movable, pointer, pointerId }) => ({
      model: DragState.guards.Dragging(model.drag)
        ? model
        : modifyFields(model, {
            drag: () => DragState.Dragging({ movable, pointer, pointerId }),
          }),
    }),
    PressedSearchArrowDown: () => searchedWith(model, moved(model.search, 1)),
    PressedSearchArrowUp: () => searchedWith(model, moved(model.search, -1)),
    PressedSearchEnter: () =>
      Option.match(model.search.maybeActive, {
        onNone: () => ({ model }),
        onSome: (node) => selectedResult(model, node),
      }),
    // Clearing leaves the pins, the drawer, the documents, the tasks and the viewport as they are.
    PressedSearchEscape: () => ({ model: modifyFields(model, { search: () => NO_SEARCH }) }),
    PannedOrZoomed: ({ viewport }) => ({
      model: modifyFields(model, { viewport: () => viewport }),
    }),
    ReceivedPresence: ({ presence }) => ({
      model: modifyFields(model, {
        participants: () => presence.participants,
        maybeYou: () => Option.some(presence.you),
      }),
    }),
    ReleasedDragPointer: ({ pointerId }) => ({
      model: Option.match(dragByPointer(model.drag, pointerId), {
        onNone: () => model,
        onSome: () => modifyFields(model, { drag: () => DragState.Released({ pointerId }) }),
      }),
    }),
    SuppressedClickAfterDrag: () => ({ model: idleAfterRelease(model) }),
    // A refreshed trace is searched again: a result that is gone loses its marks and its chain.
    SettledLoadTrace: ({ result }) => {
      const settled = modifyFields(model, { trace: AsyncData.settle(result) });
      return {
        model: modifyFields(settled, {
          search: (search) => refreshed(search, AsyncData.getData(settled.trace)),
        }),
      };
    },
  });

// COMMAND

export const LoadTrace = Command.define("LoadTrace", {
  messages: [Message.SettledLoadTrace],
  execute: loadDemoTrace.pipe(
    Effect.mapError(describeTraceError),
    Effect.result,
    Effect.map((result) => Message.SettledLoadTrace({ result })),
  ),
});
