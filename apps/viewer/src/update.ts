import { Array, Boolean, Effect, Equal, Option, Record, Schema, String } from "effect";
import { AsyncData, Command } from "foldkit";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { TOOLBAR_MARGIN, TOOLBAR_WIDTH, boundsOf, centreViewport, fitViewport } from "./canvas.ts";
import { FocusDrawerHeading, FocusNode, FocusSearch, ScrollSearchResult } from "./command.ts";
import { DRAWER_WIDTH } from "./drawer.ts";
import { DragState, canvasDeltaOf, moveBy, nudgeOf } from "./drag.ts";
import { isPinned, pin, togglePin } from "./highlight.ts";
import { describeTraceError, loadDemoTrace } from "./load.ts";
import { Message } from "./message.ts";
import { Drawer, PresenceConnection, selectedNodeOf, type Model } from "./model.ts";
import {
  EMPTY_SEARCH,
  firstActive,
  reconcileActive,
  resultOf,
  searchTrace,
  stepActive,
  type Search,
} from "./search.ts";
import { Node, nodeKeyOf } from "./trace.ts";

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

/** No buttons held: the pointer is up, whether or not its release was heard. */
const NO_BUTTONS = 0;

/**
 * The query's results over the loaded trace; none while there is no trace. This is the one place a
 * query is matched, so a keystroke or a refresh matches once, not once per render.
 */
const resultsOf = (model: Model, query: string) =>
  Option.match(AsyncData.getData(model.trace), {
    onNone: () => [],
    onSome: (trace) => (String.isEmpty(String.trim(query)) ? [] : searchTrace(trace, query)),
  });

/** A new query starts on its first result. */
const searchedFor = (model: Model, query: string): Search => {
  const results = resultsOf(model, query);
  return { maybeActive: firstActive(results), query, results };
};

/** The search after the trace changed: the same query, with the active result kept while it matches. */
const searchRefreshed = (model: Model): Search => {
  const results = resultsOf(model, model.search.query);
  return {
    maybeActive: reconcileActive(results, model.search.maybeActive),
    query: model.search.query,
    results,
  };
};

/** The pane pixels the toolbar covers at the left, and the open drawer at the right. */
const coveredBy = (model: Model) => ({
  left: TOOLBAR_MARGIN + TOOLBAR_WIDTH,
  right: Drawer.guards.Open(model.drawer) ? DRAWER_WIDTH : 0,
});

/**
 * Pans the canvas to put the node in the middle of what the toolbar and drawer leave clear, at the
 * zoom it has. A node or pane that is not measured yet leaves the viewport alone and the centring
 * pending, so the first measurement that has both finishes it.
 */
const centredOn = (model: Model, node: Node): Model =>
  Option.match(
    Option.all({ pane: model.maybePaneSize, rect: Record.get(model.positions, node.id) }),
    {
      onNone: () => modifyFields(model, { maybeCentring: () => Option.some(node) }),
      onSome: ({ pane, rect }) =>
        modifyFields(model, {
          maybeCentring: () => Option.none(),
          viewport: (viewport) => centreViewport(viewport, rect, pane, coveredBy(model)),
        }),
    },
  );

/** Finishes a pending centring once the measurements allow. */
const centringFinished = (model: Model): Model =>
  Option.match(model.maybeCentring, {
    onNone: () => model,
    onSome: (node) => centredOn(model, node),
  });

/** Selecting a result makes it the active one and brings it to the middle of the canvas. */
const resultSelected = (model: Model, node: Node): Model =>
  Option.isSome(resultOf(model.search.results, node))
    ? centredOn(
        modifyFields(model, {
          search: (search) => modifyFields(search, { maybeActive: () => Option.some(node) }),
        }),
        node,
      )
    : model;

/** Scrolls the list to the active result, when there is one. */
const scrollToActive = (search: Search) =>
  Array.fromOption(Option.map(search.maybeActive, (node) => ScrollSearchResult({ node })));

/** An arrow key moves the active result one step; the list ends stop it. */
const stepped = (model: Model, step: 1 | -1): Update.Return<Model, Message> => {
  const maybeActive = stepActive(model.search.results, model.search.maybeActive, step);
  const maybeMoved = Option.filter(
    maybeActive,
    (node) => !Option.exists(model.search.maybeActive, (active) => nodeEquivalence(active, node)),
  );
  return {
    commands: Array.fromOption(Option.map(maybeMoved, (node) => ScrollSearchResult({ node }))),
    model: modifyFields(model, {
      search: (search) => modifyFields(search, { maybeActive: () => maybeActive }),
    }),
  };
};

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
    // A click takes focus from the input, so focus goes back to it for the keys to keep working.
    ClickedSearchResult: ({ node }) => ({
      commands: [FocusSearch()],
      model: resultSelected(model, node),
    }),
    ClickedResetLayout: () => ({ model: modifyFields(model, { offsets: () => ({}) }) }),
    ClickedShowAllCurves: () => ({
      model: modifyFields(model, { isShowingAllCurves: Boolean.not }),
    }),
    // The room is unknown once the socket is gone, so nobody is shown and you are no one.
    ClosedPresence: () => ({
      model: modifyFields(model, {
        maybeYou: () => Option.none(),
        participants: () => [],
        presenceConnection: () => PresenceConnection.Disconnected(),
      }),
    }),
    CompletedFocusDrawerHeading: () => ({ model }),
    CompletedFocusNode: () => ({ model }),
    CompletedFocusSearch: () => ({ model }),
    CompletedScrollSearchResult: () => ({ model }),
    // A new query starts on its first result and drops a centring still waiting for the last one.
    // The list keeps its scroll through an edit, so the new first result is scrolled to.
    EditedSearchQuery: ({ query }) => {
      const search = searchedFor(model, query);
      return {
        commands: scrollToActive(search),
        model: modifyFields(model, { maybeCentring: () => Option.none(), search: () => search }),
      };
    },
    FailedPanZoomCanvas: ({ reason }) => ({
      model: modifyFields(model, { maybePanZoomFailure: () => Option.some(reason) }),
    }),
    HoveredNode: ({ node }) => ({
      model: modifyFields(model, { maybeHovered: () => Option.some(node) }),
    }),
    LeftNode: () => ({ model: modifyFields(model, { maybeHovered: () => Option.none() }) }),
    MeasuredLayout: ({ positions }) => ({
      model: centringFinished(modifyFields(model, { positions: () => positions })),
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
      model: centringFinished(modifyFields(model, { maybePaneSize: () => Option.some(size) })),
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
    PressedSearchArrowDown: () => stepped(model, 1),
    PressedSearchArrowUp: () => stepped(model, -1),
    PressedSearchEnter: () => ({
      model: Option.match(model.search.maybeActive, {
        onNone: () => model,
        onSome: (node) => resultSelected(model, node),
      }),
    }),
    // Clearing the search leaves the pins, the drawer and the viewport as they are.
    PressedSearchEscape: () => ({
      model: modifyFields(model, {
        maybeCentring: () => Option.none(),
        search: () => EMPTY_SEARCH,
      }),
    }),
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
    // A new trace is matched again for the same query; the active result and a pending centring
    // stay only while their node is still a result.
    SettledLoadTrace: ({ result }) => {
      const settled = modifyFields(model, { trace: AsyncData.settle(result) });
      const search = searchRefreshed(settled);
      const hasMoved = !Equal.equals(
        Option.map(model.search.maybeActive, nodeKeyOf),
        Option.map(search.maybeActive, nodeKeyOf),
      );
      return {
        commands: hasMoved ? scrollToActive(search) : [],
        model: modifyFields(settled, {
          maybeCentring: (maybeCentring) =>
            Option.filter(maybeCentring, (node) => Option.isSome(resultOf(search.results, node))),
          search: () => search,
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
