import type { Participant, Trace } from "@cairn/contract";
import { Array, Option } from "effect";
import { AsyncData } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

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

const loadingView = (h: HtmlBuilder<Message>): Html =>
  h.p([h.Role("status"), h.DataAttribute("loading", "")], ["Loading the trace..."]);

const alertView = (error: string, h: HtmlBuilder<Message>): Html => h.p([h.Role("alert")], [error]);

/** Everyone in the room but you. */
const othersOf = (model: Model): ReadonlyArray<Participant> =>
  Array.filter(
    model.participants,
    (participant) => !Option.contains(model.maybeYou, participant.id),
  );

export const view = (model: Model, h: HtmlBuilder<Message>): Document =>
  Screen.match(model.screen, {
    Reader: () => readerScreenView(model, h),
    Code: (code) => ({
      body: h.main(
        [],
        Option.match(AsyncData.getData(model.trace), {
          onNone: () => [loadingView(h)],
          onSome: (trace) => [
            codeView(
              trace,
              code,
              model.patches,
              model.diffStyle,
              model,
              model.maybeLinkNotice,
              copyLinksOf(model),
              h,
              codeMessages,
            ),
          ],
        }),
      ),
      title: "Cairn",
    }),
  });

/**
 * The reader fills the window: main is a column of the reader and, when the trace is stale, the
 * alert above it, so the window never scrolls and each pane keeps its own scroll.
 */
const readerScreenView = (model: Model, h: HtmlBuilder<Message>): Document => {
  const presence = presenceText(model, othersOf(model));
  const loaded = (trace: Trace) => readerView(trace, model, presence, h);
  return {
    body: h.main(
      [
        h.Style({
          display: "flex",
          "flex-direction": "column",
          height: "100vh",
          overflow: "hidden",
        }),
      ],
      AsyncData.match(model.trace, {
        onFailure: (error) => [alertView(error, h)],
        onIdle: () => [loadingView(h)],
        onLoading: () => [loadingView(h)],
        onRefreshing: (data) => [loaded(data)],
        onStale: ({ data, error }) => [alertView(error, h), loaded(data)],
        onSuccess: (data) => [loaded(data)],
      }),
    ),
    title: "Cairn",
  };
};
