import { Effect, Option, Schema } from "effect";
import { AsyncData, Command } from "foldkit";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { boundsOf, fitViewport } from "./canvas.ts";
import { describeTraceError, loadDemoTrace } from "./load.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { Node } from "./trace.ts";

// UPDATE

const nodeEquivalence = Schema.toEquivalence(Node);

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedCommit: ({ sha }) => ({
      model: modifyFields(model, { maybeCommit: () => Option.some(sha) }),
    }),
    // Fit frames every measured node in the pane; until both are known it does nothing.
    ClickedFit: () =>
      Option.match(Option.all({ bounds: boundsOf(model.positions), pane: model.maybePane }), {
        onNone: () => ({ model }),
        onSome: ({ bounds, pane }) => ({
          model: modifyFields(model, {
            viewport: () => fitViewport(bounds, pane.width, pane.height),
          }),
        }),
      }),
    // Clicking a node opens its drawer. Clicking the selected node clears the selection;
    // clicking any other node selects it.
    ClickedNode: ({ node }) => ({
      model: modifyFields(model, {
        maybeCommit: () => Option.none(),
        maybeDrawer: () => Option.some(node),
        maybeSelected: (maybeSelected) =>
          Option.exists(maybeSelected, (selected) => nodeEquivalence(selected, node))
            ? Option.none()
            : Option.some(node),
      }),
    }),
    ClosedDrawer: () => ({
      model: modifyFields(model, {
        maybeCommit: () => Option.none(),
        maybeDrawer: () => Option.none(),
      }),
    }),
    HoveredNode: ({ node }) => ({
      model: modifyFields(model, { maybeHovered: () => Option.some(node) }),
    }),
    LeftNode: () => ({ model: modifyFields(model, { maybeHovered: () => Option.none() }) }),
    MeasuredLayout: ({ positions }) => ({
      model: modifyFields(model, { positions: () => positions }),
    }),
    MeasuredPane: ({ size }) => ({
      model: modifyFields(model, { maybePane: () => Option.some(size) }),
    }),
    PannedOrZoomed: ({ viewport }) => ({
      model: modifyFields(model, { viewport: () => viewport }),
    }),
    ReceivedPresence: ({ presence }) => ({
      model: modifyFields(model, {
        participants: () => presence.participants,
        you: () => Option.some(presence.you),
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
