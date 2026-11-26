import type { Participant, Trace } from "@cairn/contract";
import type { Html } from "@effect/ui/html";
import { Array, Option } from "effect";
import { AsyncData } from "foldkit";

import { styleText } from "../effect-ui/attributes.ts";
import { viewerBridge } from "../effect-ui/viewerBridge.ts";
import { copyLinksOf } from "../links.ts";
import { Message } from "../message.ts";
import { PresenceConnection, Screen, type Model } from "../model.ts";
import { labelOf } from "../readers.ts";
import { codeView, type CodeMessages } from "./codeView.ts";
import { readerView } from "./readerView.ts";

const joinedText = (others: ReadonlyArray<Participant>) =>
  Array.match(others, {
    onEmpty: () => "Nobody else is here.",
    onNonEmpty: (present) => `Here now: ${Array.join(Array.map(present, labelOf), ", ")}`,
  });

const presenceText = (model: Model, others: ReadonlyArray<Participant>) =>
  PresenceConnection.match(model.presenceConnection, {
    Connected: () => joinedText(others),
    Connecting: () => joinedText(others),
    Disconnected: () => "The presence connection is lost. Other participants are not shown.",
  });

const codeMessages: CodeMessages = {
  onBack: Message.ClickedBackToPlan(),
  onDismissNotice: Message.ClickedDismissLinkNotice(),
  onDiffStyle: (style) => Message.ClickedDiffStyle({ style }),
  onClickCommit: (sha) => Message.ClickedTreeCommit({ sha }),
  onClickFile: (path) => Message.ClickedTreeFile({ path }),
  onClickTask: (id) => Message.ClickedTreeTask({ id }),
  onTurn: (id) => Message.ClickedTurn({ id }),
  onMoreOfTurn: (id) => Message.ClickedMoreOfTurn({ id }),
};

const loadingView = (h: Html.H<Message>) =>
  h.p.attr("role", "status").attr("data-loading", "").children("Loading the trace...");

const alertView = (h: Html.H<Message>, error: string) => h.p.attr("role", "alert").children(error);

/** Everyone in the room but you. */
const othersOf = (model: Model): ReadonlyArray<Participant> =>
  Array.filter(
    model.participants,
    (participant) => !Option.contains(model.maybeYou, participant.id),
  );

/**
 * The viewer's whole view: the reader or the code view, in `main`. `Viewer` calls it inside
 * `viewerBridge.render`, so the views under it that are still Foldkit build in one pass. The code
 * view is one of them.
 */
export const view = (h: Html.H<Message>, model: Model) =>
  Screen.match(model.screen, {
    Reader: () => readerScreenView(h, model),
    Code: (code) =>
      h.main(
        Option.match(AsyncData.getData(model.trace), {
          onNone: () => loadingView(h),
          onSome: (trace) =>
            viewerBridge.bridged(h, (foldkit) =>
              codeView(
                trace,
                code,
                model.patches,
                model.diffStyle,
                model,
                model.maybeLinkNotice,
                copyLinksOf(model),
                foldkit,
                codeMessages,
              ),
            ),
        }),
      ),
  });

/**
 * The reader fills the window: main is a column of the reader and, when the trace is stale, the
 * alert above it, so the window never scrolls and each pane keeps its own scroll.
 */
const readerScreenView = (h: Html.H<Message>, model: Model) => {
  const presence = presenceText(model, othersOf(model));
  const loaded = (trace: Trace) => readerView(h, trace, model, presence);
  return h.main
    .attr(
      "style",
      styleText({
        display: "flex",
        "flex-direction": "column",
        height: "100vh",
        overflow: "hidden",
      }),
    )
    .children(
      AsyncData.match(model.trace, {
        onFailure: (error) => alertView(h, error),
        onIdle: () => loadingView(h),
        onLoading: () => loadingView(h),
        onRefreshing: (data) => loaded(data),
        onStale: ({ data, error }) => [alertView(h, error), loaded(data)],
        onSuccess: (data) => loaded(data),
      }),
    );
};
