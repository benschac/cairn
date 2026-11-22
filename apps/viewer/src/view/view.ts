import type { Participant, Trace } from "@cairn/contract";
import { Array, Option } from "effect";
import { AsyncData } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { drawerView, type DrawerMessages } from "../drawer.ts";
import { Message } from "../message.ts";
import { Drawer, selectedNodeOf, type Model } from "../model.ts";
import { canvasView } from "./canvasView.ts";
import { labelOf } from "./cursorsView.ts";

const presenceText = (others: ReadonlyArray<Participant>) =>
  Array.match(others, {
    onEmpty: () => "Nobody else is here.",
    onNonEmpty: (present) => `Here now: ${Array.join(Array.map(present, labelOf), ", ")}`,
  });

const drawerMessages: DrawerMessages<Message> = {
  onClickCommit: (sha) => Message.ClickedCommit({ sha }),
  onClickTask: (id) => Message.ClickedDrawerTask({ id }),
  onClose: Message.ClickedCloseDrawer(),
};

/** The open drawer, holding the commit clicked in it; nothing while the drawer is closed. */
const drawerViews = (model: Model, trace: Trace, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Drawer.match(model.drawer, {
    Closed: () => [],
    Open: ({ maybeCommitSha, node }) => [
      drawerView(trace, node, maybeCommitSha, h, drawerMessages),
    ],
  });

const loadingView = (h: HtmlBuilder<Message>): Html =>
  h.p([h.Role("status"), h.DataAttribute("loading", "")], ["Loading the trace..."]);

const alertView = (error: string, h: HtmlBuilder<Message>): Html => h.p([h.Role("alert")], [error]);

// NOTE: a native button with Type("button"). @foldkit/ui's Button.view adds only Tabindex(0)
// over that, so it is not a dependency.
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
  const maybeSelected = selectedNodeOf(model.drawer);
  const maybeActive = Option.orElse(model.maybeHovered, () => maybeSelected);
  // The Fit button, the canvas and the drawer, shown whenever there is a trace to pan over.
  const canvas = (trace: Trace): ReadonlyArray<Html> =>
    Array.appendAll(
      [
        fitButton(h),
        canvasView(trace, model.positions, model.viewport, maybeActive, maybeSelected, others, h),
      ],
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
