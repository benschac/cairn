import { PrdSectionId, type Sha, type TaskId, type Trace } from "@cairn/contract";
import { Array, Boolean, Effect, Match, Option, Record, Result, Schema } from "effect";
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
import { codeScreenOf, filesOf, ownerOf, patchPathOf, taskOf } from "./codeView.ts";
import {
  FetchPatch,
  FocusDrawerHeading,
  FocusNode,
  FocusSearchInput,
  ScrollSearchResult,
} from "./command.ts";
import { DragState, canvasDeltaOf, moveBy, nudgeOf } from "./drag.ts";
import { DRAWER_WIDTH } from "./drawer.ts";
import type { Rect } from "./geometry.ts";
import { isPinned, pin, togglePin } from "./highlight.ts";
import { describeTraceError, isDemoBuild, loadDemoTrace } from "./load.ts";
import { Message } from "./message.ts";
import {
  Drawer,
  PatchData,
  PresenceConnection,
  Screen,
  selectedNodeOf,
  type Destination,
  type Model,
} from "./model.ts";
import {
  NO_SEARCH,
  blockKeyOf,
  chosen,
  moved,
  queried,
  refreshed,
  resultOf,
  type SearchState,
} from "./search.ts";
import { Resize, deltaOf, draggedTo, resized, stepOf } from "./panes.ts";
import { isOpenCard } from "./reader.ts";
import { Node } from "./trace.ts";

// UPDATE

const nodeEquivalence = Schema.toEquivalence(Node);

const openOn = (node: Node): Drawer => Drawer.Open({ node });

/** The trace, once it has loaded; the code view reads tasks and commits from it. */
const traceOf = (model: Model): Option.Option<Trace> => AsyncData.getData(model.trace);

/** The task the code view is on, and what is shown of it. */
const shownIn = (model: Model) =>
  Option.flatMap(Option.liftPredicate(model.screen, Screen.guards.Code), (code) =>
    Option.map(
      Option.flatMap(traceOf(model), (trace) => taskOf(trace, code.taskId)),
      (task) => ({ code, task }),
    ),
  );

/**
 * The patch the code view is on must be in the model. A path that is loading or loaded is left
 * alone; one that is new, or failed before, is marked loading and fetched. The demo build has no
 * server, so it fetches nothing.
 */
const withPatchRequested = (model: Model): Update.Return<Model, Message> =>
  Option.match(
    Option.filter(
      Option.flatMap(shownIn(model), ({ code, task }) => patchPathOf(task, code.shown)),
      () => !isDemoBuild(),
    ),
    {
      onNone: () => ({ model }),
      onSome: (path) =>
        Option.exists(Record.get(model.patches, path), (data) => !PatchData.guards.Failed(data))
          ? { model }
          : {
              commands: [FetchPatch({ path })],
              model: modifyFields(model, { patches: Record.set(path, PatchData.Loading()) }),
            },
    },
  );

/** The code view with what is shown of a task, when the trace has that task and commit. */
const codeOn = (
  model: Model,
  id: TaskId,
  maybeSha: Option.Option<Sha>,
): Update.Return<Model, Message> =>
  Option.match(
    Option.flatMap(traceOf(model), (trace) => codeScreenOf(trace, id, maybeSha)),
    {
      onNone: () => ({ model }),
      onSome: (screen) => withPatchRequested(modifyFields(model, { screen: () => screen })),
    },
  );

/** The drag this pointer is making; none while nothing is dragged or another pointer drags. */
const dragByPointer = (drag: DragState, pointerId: number) =>
  Option.filter(
    Option.liftPredicate(drag, DragState.guards.Dragging),
    (dragging) => dragging.pointerId === pointerId,
  );

/** The resize this pointer is making; none while nothing is resized or another pointer resizes. */
const resizeByPointer = (resize: Resize, pointerId: number) =>
  Option.filter(
    Option.liftPredicate(resize, Resize.guards.Resizing),
    (resizing) => resizing.pointerId === pointerId,
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

/** Where a result is seen, and whether that is as close as it gets: a section stands in for an unmeasured block. */
interface Seen {
  readonly isFinal: boolean;
  readonly rect: Rect;
}

/**
 * What a result is seen at: its matched prose block once layout has measured it, otherwise the
 * node that owns it, which is not final while the result has a block still to be measured.
 */
const seenAt = (model: Model, node: Node): Option.Option<Seen> => {
  const maybeKey = Option.flatMap(resultOf(model.search.results, node), blockKeyOf);
  return Option.orElse(
    Option.map(
      Option.flatMap(maybeKey, (key) => Record.get(model.positions, key)),
      (rect): Seen => ({ isFinal: true, rect }),
    ),
    () =>
      Option.map(Record.get(model.positions, node.id), (rect): Seen => ({
        isFinal: Option.isNone(maybeKey),
        rect,
      })),
  );
};

/**
 * Brings the result waiting to be seen into the middle of what the pane shows, at the zoom it has.
 * It is its matched prose block when that is measured, and the section that owns the block until it
 * is: the canvas moves to the section at once and the result stays waiting, so the block it
 * measures later moves the canvas again. Until layout has measured the node and the pane its size,
 * it keeps waiting; the measurements include a moved card's offset.
 */
const centeredOnSearch = (model: Model): Model =>
  Option.match(
    Option.flatMap(
      Option.all({ node: model.search.maybeToCenter, pane: model.maybePaneSize }),
      ({ node, pane }) =>
        Option.map(seenAt(model, node), ({ isFinal, rect }) => ({
          isFinal,
          viewport: centerViewport(rect, model.viewport, pane, insetsOf(model.drawer)),
        })),
    ),
    {
      onNone: () => model,
      onSome: ({ isFinal, viewport }) =>
        modifyFields(model, {
          search: (search) =>
            isFinal ? modifyFields(search, { maybeToCenter: () => Option.none() }) : search,
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

/** The screen a "Plan" or "Canvas" button moves to. */
const screenOf = (destination: Destination): Screen =>
  Match.value(destination).pipe(
    Match.when("Canvas", () => Screen.Canvas()),
    Match.when("Reader", () => Screen.Reader()),
    Match.exhaustive,
  );

/** A pinned section is unpinned by a second click on its status line; any other becomes the pin. */
const pinToggled = (maybePinned: Option.Option<PrdSectionId>, id: PrdSectionId) =>
  Option.contains(maybePinned, id) ? Option.none() : Option.some(id);

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
    // Back to the canvas changes only the screen: pins, offsets, the drawer and the viewport stayed.
    ClickedBackToCanvas: () => ({ model: modifyFields(model, { screen: () => Screen.Canvas() }) }),
    // A card opens or closes alone, to the opposite of what it shows now.
    ClickedCardHeader: ({ id }) => ({
      model: modifyFields(model, {
        reader: (reader) =>
          modifyFields(reader, { opened: Record.set(id, !isOpenCard(reader, id)) }),
      }),
    }),
    // The control sets every card to its density, so the cards opened apart from it are forgotten.
    ClickedDensity: ({ density }) => ({
      model: modifyFields(model, {
        reader: (reader) => modifyFields(reader, { density: () => density, opened: () => ({}) }),
      }),
    }),
    // Until the detail panel exists, a task row opens the task's drawer, which is the selection.
    ClickedTask: ({ id }) => ({
      model: modifyFields(model, { drawer: () => openOn({ id, kind: "task" }) }),
    }),
    // "Open code" and a drawer commit open the code view; a task or commit the trace lacks opens nothing.
    ClickedOpenCode: ({ id, maybeSha }) => codeOn(model, id, maybeSha),
    // The tree selects within the code view; with the canvas showing there is no tree to click.
    ClickedTreeCommit: ({ sha }) =>
      Option.match(shownIn(model), {
        onNone: () => ({ model }),
        onSome: () =>
          Option.match(
            Option.flatMap(traceOf(model), (trace) => ownerOf(trace, sha)),
            {
              onNone: () => ({ model }),
              onSome: (task) => codeOn(model, task.id, Option.some(sha)),
            },
          ),
      }),
    ClickedTreeFile: ({ path }) => ({
      model: Option.match(
        Option.filter(shownIn(model), ({ code, task }) =>
          Array.contains(filesOf(task, code.shown), path),
        ),
        {
          onNone: () => model,
          onSome: ({ code }) =>
            modifyFields(model, {
              screen: () => Screen.Code({ ...code, maybeFile: Option.some(path) }),
            }),
        },
      ),
    }),
    ClickedTreeTask: ({ id }) =>
      Option.match(shownIn(model), {
        onNone: () => ({ model }),
        onSome: () => codeOn(model, id, Option.none()),
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
    ClickedScreen: ({ screen }) => ({
      model: modifyFields(model, { screen: () => screenOf(screen) }),
    }),
    ClickedSectionId: ({ id }) => ({ commands: [CopySectionId({ id })], model }),
    // Pinning keeps the pane where it is; the pinned section stays current while the PRD scrolls.
    ClickedStatusLine: ({ id }) => ({
      model: modifyFields(model, {
        maybeCopied: () => Option.none(),
        reader: (reader) =>
          modifyFields(reader, { maybePinned: (maybePinned) => pinToggled(maybePinned, id) }),
      }),
    }),
    ClickedResetLayout: () => ({ model: modifyFields(model, { offsets: () => ({}) }) }),
    // A click takes focus from the input, so it goes back: the keyboard stays in search.
    ClickedSearchResult: ({ node }) => ({
      ...selectedResult(model, node),
      commands: [FocusSearchInput()],
    }),
    ClickedDiffStyle: ({ style }) => ({
      model: modifyFields(model, { diffStyle: () => style }),
    }),
    ClickedModelsSwitch: () => ({
      model: modifyFields(model, { isShowingModels: Boolean.not }),
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
    // A refused copy leaves the button as it was.
    CompletedCopySectionId: ({ id, isCopied }) => ({
      model: modifyFields(model, {
        maybeCopied: () => (isCopied ? Option.some(id) : Option.none()),
      }),
    }),
    CompletedFocusDrawerHeading: () => ({ model }),
    CompletedFocusNode: () => ({ model }),
    CompletedFocusSearchInput: () => ({ model }),
    CompletedScrollSearchResult: () => ({ model }),
    CompletedScrollStacks: () => ({ model }),
    CompletedRenderDiff: () => ({ model }),
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
    MeasuredWires: ({ measured }) => ({
      model: modifyFields(model, { maybeMeasuredWires: () => Option.some(measured) }),
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
    PressedArrowOnDivider: ({ key, pane }) => ({
      model: modifyFields(model, {
        widths: (widths) => resized(widths, pane, deltaOf(pane, stepOf(key))),
      }),
    }),
    // One resize at a time, as with a drag: a second finger cannot take it over.
    PressedDivider: ({ pane, pointerId, x }) => ({
      model: Resize.guards.Resizing(model.resize)
        ? model
        : modifyFields(model, {
            resize: () =>
              Resize.Resizing({ pane, pointerId, startWidth: model.widths[pane], startX: x }),
          }),
    }),
    // A move with no button held means the release was missed: the resize ends there.
    MovedResizePointer: ({ buttons, pointerId, x }) => ({
      model: Option.match(resizeByPointer(model.resize, pointerId), {
        onNone: () => model,
        onSome: (resizing) =>
          buttons === NO_BUTTONS
            ? modifyFields(model, { resize: () => Resize.Idle() })
            : modifyFields(model, { widths: (widths) => draggedTo(widths, resizing, x) }),
      }),
    }),
    ReleasedResizePointer: ({ pointerId }) => ({
      model: Option.match(resizeByPointer(model.resize, pointerId), {
        onNone: () => model,
        onSome: () => modifyFields(model, { resize: () => Resize.Idle() }),
      }),
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
    // Until the detail panel exists there is nothing to go back through, so Escape unpins. It is
    // the reader's key: on any other screen it does nothing.
    PressedEscape: () => ({
      model: Screen.guards.Reader(model.screen)
        ? modifyFields(model, {
            maybeCopied: () => Option.none(),
            reader: (reader) => modifyFields(reader, { maybePinned: () => Option.none() }),
          })
        : model,
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
    // A patch that arrived stays in the model, loaded or failed, so selecting it again draws it
    // without a fetch, or fetches it again after a failure.
    ReceivedPatch: ({ path, result }) => ({
      model: modifyFields(model, {
        patches: Record.set(
          path,
          Result.match(result, {
            onFailure: (reason) => PatchData.Failed({ message: reason }),
            onSuccess: (text) => PatchData.Loaded({ text }),
          }),
        ),
      }),
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
    // Only the section at the top changes on a scroll.
    ScrolledPrd: ({ id }) => ({
      model: modifyFields(model, {
        reader: (reader) => modifyFields(reader, { maybeAtTop: () => Option.some(id) }),
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

/** Writes a section's ID to the clipboard, and says whether the browser took it. */
export const CopySectionId = Command.define("CopySectionId", {
  args: { id: PrdSectionId },
  messages: [Message.CompletedCopySectionId],
  execute: ({ id }) =>
    Effect.tryPromise({
      catch: () => "The browser refused to copy",
      try: () => navigator.clipboard.writeText(id),
    }).pipe(
      Effect.result,
      Effect.map((result) =>
        Message.CompletedCopySectionId({ id, isCopied: Result.isSuccess(result) }),
      ),
    ),
});

export const LoadTrace = Command.define("LoadTrace", {
  messages: [Message.SettledLoadTrace],
  execute: loadDemoTrace.pipe(
    Effect.mapError(describeTraceError),
    Effect.result,
    Effect.map((result) => Message.SettledLoadTrace({ result })),
  ),
});
