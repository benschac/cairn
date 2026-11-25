import { PrdSectionId, type Sha, type TaskId, type Trace } from "@cairn/contract";
import { Array, Boolean, Effect, Match, Option, Record, Result, Schema } from "effect";
import { AsyncData, Command, Dom } from "foldkit";
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
import {
  DETAIL_HEADING_ID,
  cutBackTo,
  extendedBy,
  nodeShownBy,
  openedOn,
  wentBack,
} from "./detail.ts";
import { DRAWER_WIDTH } from "./drawer.ts";
import type { Rect } from "./geometry.ts";
import { isPinned, pin, togglePin } from "./highlight.ts";
import { describeTraceError, isDemoBuild, loadDemoTrace } from "./load.ts";
import { Message } from "./message.ts";
import { keptReaders, readersOf } from "./readers.ts";
import {
  Drawer,
  PatchData,
  PresenceConnection,
  Screen,
  Shown,
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
import { Resize, deltaOf, draggedTo, fittedTo, resized, stepOf } from "./panes.ts";
import type { Trail } from "./detail.ts";
import { ScrollTarget, isCardless, isOpenCard, isOpenPrdSection, targetsOf } from "./reader.ts";
import { Node } from "./trace.ts";

// UPDATE

const nodeEquivalence = Schema.toEquivalence(Node);

const sameNode = Option.makeEquivalence(nodeEquivalence);

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
const patchRequested = (model: Model, path: string): Update.Return<Model, Message> =>
  isDemoBuild() ||
  Option.exists(Record.get(model.patches, path), (data) => !PatchData.guards.Failed(data))
    ? { model }
    : {
        commands: [FetchPatch({ path })],
        model: modifyFields(model, { patches: Record.set(path, PatchData.Loading()) }),
      };

const withPatchRequested = (model: Model): Update.Return<Model, Message> =>
  Option.match(
    Option.flatMap(shownIn(model), ({ code, task }) => patchPathOf(task, code.shown)),
    { onNone: () => ({ model }), onSome: (path) => patchRequested(model, path) },
  );

/** The route of the whole diff of the task the detail panel is on; none for a section or a task without one. */
const detailPatchPathOf = (model: Model): Option.Option<string> =>
  Option.flatMap(nodeShownBy(model.detail), (node) =>
    Node.match(node, {
      section: () => Option.none(),
      task: ({ id }) =>
        Option.flatMap(
          Option.flatMap(traceOf(model), (trace) => taskOf(trace, id)),
          (task) => patchPathOf(task, Shown.WholeTask()),
        ),
    }),
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

/**
 * The model with this trail. When the panel is open and its last node changed, focus moves to the
 * panel's heading; a trail that shows the same node, or none, moves no focus.
 */
const detailTrailed = (model: Model, trail: Trail): Update.Return<Model, Message> => {
  const trailed = modifyFields(model, { detail: () => trail });
  // A task with commits shows its whole diff, so it is fetched unless the model has it.
  const requested = Option.match(detailPatchPathOf(trailed), {
    onNone: (): Update.Return<Model, Message> => ({ model: trailed }),
    onSome: (path) => patchRequested(trailed, path),
  });
  return {
    commands: Array.appendAll(
      Option.isSome(nodeShownBy(trail)) && !sameNode(nodeShownBy(trail), nodeShownBy(model.detail))
        ? [FocusDetailHeading()]
        : [],
      Option.getOrElse(Option.fromNullishOr(requested.commands), () => []),
    ),
    model: requested.model,
  };
};

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

/**
 * A result chosen by Enter or a click in the reader: it is active, which makes its first PRD
 * section current while it stays so. Its place in each pane is brought into view. A spec section
 * that implements no PRD section has no card to go to, so it opens in the detail panel, the one
 * case where a result opens the panel. Nothing here moves focus: it stays in the search input.
 */
const selectedInReader = (model: Model, node: Node): Update.Return<Model, Message> => {
  const selected = modifyFields(model, {
    search: (search) => modifyFields(chosen(search, node), { maybeToCenter: () => Option.none() }),
  });
  return Option.match(
    Option.all({ result: resultOf(selected.search.results, node), trace: traceOf(model) }),
    {
      onNone: () => ({ model: selected }),
      onSome: ({ result, trace }) =>
        isCardless(trace, node)
          ? { model: modifyFields(selected, { detail: () => openedOn(node) }) }
          : { commands: [ScrollSearchTargets({ targets: targetsOf(result) })], model: selected },
    },
  );
};

/** A result chosen by Enter or a click: it is active, and the screen moves to it. */
const selectedResult = (model: Model, node: Node): Update.Return<Model, Message> =>
  Screen.guards.Reader(model.screen)
    ? selectedInReader(model, node)
    : {
        model: centeredOnSearch(modifyFields(model, { search: (search) => chosen(search, node) })),
      };

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
    // A PRD section opens or closes alone, to the opposite of what it shows now.
    ClickedPrdHeading: ({ id }) => ({
      model: modifyFields(model, {
        reader: (reader) =>
          modifyFields(reader, { prdOpened: Record.set(id, !isOpenPrdSection(reader, id)) }),
      }),
    }),
    // Collapsing or expanding every section forgets the sections opened or closed on their own.
    ClickedCondensePrd: () => ({
      model: modifyFields(model, {
        reader: (reader) =>
          modifyFields(reader, { isPrdCondensed: Boolean.not, prdOpened: () => ({}) }),
      }),
    }),
    // A task row or a chip starts a new trail on that task.
    ClickedTask: ({ id }) => detailTrailed(model, openedOn({ id, kind: "task" })),
    ClickedDetailNode: ({ node }) => detailTrailed(model, extendedBy(model.detail, node)),
    ClickedTrailStep: ({ index }) => detailTrailed(model, cutBackTo(model.detail, index)),
    ClickedCloseDetail: () => ({ model: modifyFields(model, { detail: () => [] }) }),
    ClickedTraceSection: ({ id }) => ({ commands: [ScrollPrdSection({ id })], model }),
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
    ClickedSearchResult: ({ node }) => {
      const selected = selectedResult(model, node);
      return {
        commands: Array.append(
          Option.getOrElse(Option.fromNullishOr(selected.commands), () => []),
          FocusSearchInput(),
        ),
        model: selected.model,
      };
    },
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
        readers: () => [],
        presenceConnection: () => PresenceConnection.Disconnected(),
      }),
    }),
    // A refused copy leaves the button as it was.
    CompletedCopySectionId: ({ id, isCopied }) => ({
      model: modifyFields(model, {
        maybeCopied: () => (isCopied ? Option.some(id) : Option.none()),
      }),
    }),
    CompletedFocusDetailHeading: () => ({ model }),
    CompletedFocusDrawerHeading: () => ({ model }),
    CompletedScrollPrdSection: () => ({ model }),
    CompletedFocusNode: () => ({ model }),
    CompletedFocusSearchInput: () => ({ model }),
    CompletedScrollSearchResult: () => ({ model }),
    CompletedScrollSearchTargets: () => ({ model }),
    // Until a person moves its divider, the stacks pane is as wide as its chart.
    CompletedScrollStacks: ({ maybeChartWidth }) => ({
      model: Option.match(
        Option.filter(maybeChartWidth, () => !model.hasChosenStacksWidth),
        {
          onNone: () => model,
          onSome: (width) =>
            modifyFields(model, { widths: (widths) => fittedTo(widths, "stacks", width) }),
        },
      ),
    }),
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
        hasChosenStacksWidth: (hasChosen) => hasChosen || pane === "stacks",
        widths: (widths) => resized(widths, pane, deltaOf(pane, stepOf(key))),
      }),
    }),
    // One resize at a time, as with a drag: a second finger cannot take it over.
    PressedDivider: ({ maybeWidth, pane, pointerId, x }) => ({
      model: Resize.guards.Resizing(model.resize)
        ? model
        : modifyFields(model, {
            hasChosenStacksWidth: (hasChosen) => hasChosen || pane === "stacks",
            resize: () =>
              Resize.Resizing({
                pane,
                pointerId,
                // The rendered width, which the grid may hold below the chosen one.
                startWidth: Option.getOrElse(maybeWidth, () => model.widths[pane]),
                startX: x,
              }),
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
    // It is the reader's key: on any other screen it does nothing. With the detail panel open it
    // goes back one step, which closes the panel at the first; otherwise it unpins.
    PressedEscape: () =>
      Screen.guards.Reader(model.screen)
        ? Array.match(model.detail, {
            onEmpty: () => ({
              model: modifyFields(model, {
                maybeCopied: () => Option.none(),
                reader: (reader) => modifyFields(reader, { maybePinned: () => Option.none() }),
              }),
            }),
            onNonEmpty: (trail) => detailTrailed(model, wentBack(trail)),
          })
        : { model },
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
        readers: (current) =>
          keptReaders(current, readersOf(presence.participants, Option.some(presence.you))),
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

/** Moves focus to the heading of the detail panel that just opened or changed its node. */
export const FocusDetailHeading = Command.define("FocusDetailHeading", {
  messages: [Message.CompletedFocusDetailHeading],
  execute: Dom.focus(`#${DETAIL_HEADING_ID}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusDetailHeading()),
  ),
});

/** The heading of a PRD section in the PRD pane; the document's own title is not one. */
const prdHeadingSelector = (id: PrdSectionId): string => `[data-section="${id}"]:not([data-title])`;

/** Scrolls the PRD pane so a section's heading is at its top. */
export const ScrollPrdSection = Command.define("ScrollPrdSection", {
  args: { id: PrdSectionId },
  messages: [Message.CompletedScrollPrdSection],
  execute: ({ id }) =>
    Dom.scrollIntoView(prdHeadingSelector(id), { block: "start" }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollPrdSection()),
    ),
});

/**
 * Brings what a selected result points at into view, each target in its own pane. A target whose
 * element is not in the page, such as a prose block still to be rendered, falls back to the next
 * selector; one that has none is left alone.
 */
export const ScrollSearchTargets = Command.define("ScrollSearchTargets", {
  args: { targets: Schema.Array(ScrollTarget) },
  messages: [Message.CompletedScrollSearchTargets],
  execute: ({ targets }) =>
    Effect.forEach(
      targets,
      ({ block, selectors }) =>
        Effect.firstSuccessOf(
          Array.map(selectors, (selector) => Dom.scrollIntoViewAfterPaint(selector, { block })),
        ).pipe(Effect.ignore),
      { discard: true },
    ).pipe(Effect.as(Message.CompletedScrollSearchTargets())),
});

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
