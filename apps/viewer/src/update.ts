import { Boolean, Effect, Option, Schema } from "effect";
import { AsyncData, Command } from "foldkit";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { boundsOf, fitViewport } from "./canvas.ts";
import { FocusDrawerHeading, FocusNode } from "./command.ts";
import { describeTraceError, loadDemoTrace } from "./load.ts";
import { Message } from "./message.ts";
import { Drawer, PresenceConnection, selectedNodeOf, type Model } from "./model.ts";
import { Node } from "./trace.ts";

// UPDATE

const nodeEquivalence = Schema.toEquivalence(Node);

const openOn = (node: Node): Drawer => Drawer.Open({ maybeCommitSha: Option.none(), node });

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
    // A task in a section's drawer opens that task's drawer; it never closes one.
    ClickedDrawerTask: ({ id }) => ({
      commands: [FocusDrawerHeading()],
      model: modifyFields(model, { drawer: () => openOn({ id, kind: "task" }) }),
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
    // The open drawer is the selection. Clicking the node whose drawer is open closes it;
    // clicking any other node opens that node's drawer and moves focus to its heading. The
    // click that closes a drawer comes from the node's own button, so focus is already there.
    ClickedNode: ({ node }) =>
      Option.exists(selectedNodeOf(model.drawer), (selected) => nodeEquivalence(selected, node))
        ? { model: modifyFields(model, { drawer: () => Drawer.Closed() }) }
        : {
            commands: [FocusDrawerHeading()],
            model: modifyFields(model, { drawer: () => openOn(node) }),
          },
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
    FailedPanZoomCanvas: ({ reason }) => ({
      model: modifyFields(model, { maybePanZoomFailure: () => Option.some(reason) }),
    }),
    HoveredNode: ({ node }) => ({
      model: modifyFields(model, { maybeHovered: () => Option.some(node) }),
    }),
    LeftNode: () => ({ model: modifyFields(model, { maybeHovered: () => Option.none() }) }),
    MeasuredLayout: ({ positions }) => ({
      model: modifyFields(model, { positions: () => positions }),
    }),
    MeasuredPane: ({ size }) => ({
      model: modifyFields(model, { maybePaneSize: () => Option.some(size) }),
    }),
    OpenedPresence: () => ({
      model: modifyFields(model, { presenceConnection: () => PresenceConnection.Connected() }),
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
    SettledLoadTrace: ({ result }) => ({
      model: modifyFields(model, { trace: AsyncData.settle(result) }),
    }),
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
