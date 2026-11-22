import type { Participant, Trace } from "@cairn/contract";
import { Array, Option } from "effect";
import { AsyncData } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { commitDetailView, drawerView, type DrawerMessages } from "../drawer.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { canvasView } from "./canvasView.ts";
import { labelOf } from "./cursorsView.ts";

const presenceText = (others: ReadonlyArray<Participant>) =>
  Array.match(others, {
    onEmpty: () => "Nobody else is here.",
    onNonEmpty: (present) => `Here now: ${Array.join(Array.map(present, labelOf), ", ")}`,
  });

const drawerMessages: DrawerMessages<Message> = {
  onClickCommit: (sha) => Message.ClickedCommit({ sha }),
  onClickTask: (id) => Message.ClickedNode({ node: { id, kind: "task" } }),
  onClose: Message.ClosedDrawer(),
};

/** The open drawer and, below it, the commit clicked in it; nothing while the drawer is closed. */
const drawerViews = (model: Model, trace: Trace, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(model.maybeDrawer, {
    onNone: () => [],
    onSome: (node) =>
      Array.prepend(
        Array.fromOption(
          Option.flatMap(model.maybeSelectedCommitSha, (sha) => commitDetailView(trace, sha, h)),
        ),
        drawerView(trace, node, h, drawerMessages),
      ),
  });

const loadingView = (h: HtmlBuilder<Message>): Html =>
  h.p([h.DataAttribute("loading", "")], ["Loading the trace..."]);

const alertView = (error: string, h: HtmlBuilder<Message>): Html => h.p([h.Role("alert")], [error]);

const fitButton = (h: HtmlBuilder<Message>): Html =>
  h.button([h.Type("button"), h.OnClick(Message.ClickedFit())], ["Fit to view"]);

/** Everyone in the room but you. */
const othersOf = (model: Model): ReadonlyArray<Participant> =>
  Array.filter(
    model.participants,
    (participant) => !Option.contains(model.maybeYou, participant.id),
  );

const traceView = (
  model: Model,
  others: ReadonlyArray<Participant>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const maybeActive = Option.orElse(model.maybeHovered, () => model.maybeSelected);
  // The Fit button, the canvas and the drawer, shown whenever there is a trace to pan over.
  const canvas = (trace: Trace): ReadonlyArray<Html> =>
    Array.appendAll(
      [fitButton(h), canvasView(trace, model.positions, model.viewport, maybeActive, others, h)],
      drawerViews(model, trace, h),
    );
  return AsyncData.match(model.trace, {
    onFailure: (error) => [alertView(error, h)],
    onIdle: () => [loadingView(h)],
    onLoading: () => [loadingView(h)],
    onRefreshing: canvas,
    onStale: ({ data, error }) => Array.prepend(canvas(data), alertView(error, h)),
    onSuccess: canvas,
  });
};

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const others = othersOf(model);
  return {
    body: h.main(
      [],
      Array.flatten([
        [h.h1([], ["Cairn"]), h.p([h.Role("status")], [presenceText(others)])],
        traceView(model, others, h),
      ]),
    ),
    title: "Cairn",
  };
};
