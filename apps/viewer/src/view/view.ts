import type { Participant, Trace } from "@cairn/contract";
import { Array, Option } from "effect";
import { AsyncData } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { TOOLBAR_MARGIN, TOOLBAR_WIDTH } from "../canvas.ts";
import { drawerView, type DrawerMessages } from "../drawer.ts";
import type { Pin } from "../highlight.ts";
import { Message } from "../message.ts";
import { Drawer, PresenceConnection, Screen, type Model } from "../model.ts";
import { codeView, type CodeMessages } from "./codeView.ts";
import { canvasView } from "./canvasView.ts";
import { labelOf } from "./cursorsView.ts";
import { readerView, screenSwitchView } from "./readerView.ts";
import { searchView } from "./searchView.ts";

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

const drawerMessages: DrawerMessages<Message> = {
  onOpenCode: (id, maybeSha) => Message.ClickedOpenCode({ id, maybeSha }),
  onClickTask: (id) => Message.ClickedDrawerTask({ id }),
  onClose: Message.ClickedCloseDrawer(),
};

/** The open drawer, holding the commit clicked in it; nothing while the drawer is closed. */
const drawerViews = (model: Model, trace: Trace, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Drawer.match(model.drawer, {
    Closed: () => [],
    Open: ({ node }) => [drawerView(trace, node, h, drawerMessages)],
  });

const codeMessages: CodeMessages = {
  onBack: Message.ClickedBackToCanvas(),
  onDiffStyle: (style) => Message.ClickedDiffStyle({ style }),
  onClickCommit: (sha) => Message.ClickedTreeCommit({ sha }),
  onClickFile: (path) => Message.ClickedTreeFile({ path }),
  onClickTask: (id) => Message.ClickedTreeTask({ id }),
};

const loadingView = (h: HtmlBuilder<Message>): Html =>
  h.p([h.Role("status"), h.DataAttribute("loading", "")], ["Loading the trace..."]);

const alertView = (error: string, h: HtmlBuilder<Message>): Html => h.p([h.Role("alert")], [error]);

// NOTE: a native button with Type("button"). @foldkit/ui's Button.view adds only Tabindex(0)
// over that, so it is not a dependency.
const fitButton = (h: HtmlBuilder<Message>): Html =>
  h.button([h.Type("button"), h.OnClick(Message.ClickedFit())], ["Fit to view"]);

/** Unpins every node, and says how many are pinned; disabled while none is. */
const clearPinsButton = (pins: ReadonlyArray<Pin>, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Disabled(Array.isReadonlyArrayEmpty(pins)),
      h.OnClick(Message.ClickedClearPins()),
    ],
    [
      Array.match(pins, {
        onEmpty: () => "Clear pins",
        onNonEmpty: (pinned) => `Clear pins (${Array.length(pinned)})`,
      }),
    ],
  );

/** Puts every moved document and task card back where the layout put it. */
const resetLayoutButton = (h: HtmlBuilder<Message>): Html =>
  h.button([h.Type("button"), h.OnClick(Message.ClickedResetLayout())], ["Reset layout"]);

/** Pressed while every curve is drawn; released, only the hovered or selected chain's are. */
const showAllCurvesButton = (isShowingAllCurves: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.AriaPressed(String(isShowingAllCurves)),
      h.OnClick(Message.ClickedShowAllCurves()),
    ],
    ["Show all curves"],
  );

/** Everyone in the room but you. */
const othersOf = (model: Model): ReadonlyArray<Participant> =>
  Array.filter(
    model.participants,
    (participant) => !Option.contains(model.maybeYou, participant.id),
  );

/** What the trace's state puts on the page: lines and buttons for the toolbar, and the canvas and drawer over the whole screen. */
interface TraceParts {
  readonly toolbar: ReadonlyArray<Html>;
  readonly screen: ReadonlyArray<Html>;
}

const traceParts = (
  model: Model,
  others: ReadonlyArray<Participant>,
  h: HtmlBuilder<Message>,
): TraceParts => {
  // The toolbar's buttons, the canvas and the drawer, shown whenever there is a trace to pan over.
  const loaded = (trace: Trace): TraceParts => ({
    screen: Array.prepend(
      drawerViews(model, trace, h),
      canvasView(
        trace,
        model.positions,
        model.viewport,
        model.maybeHovered,
        model.pins,
        model.search.results,
        model.search.maybeActive,
        model.isShowingAllCurves,
        model.offsets,
        model.drag,
        others,
        h,
      ),
    ),
    toolbar: [
      searchView(trace, model.search, h),
      fitButton(h),
      resetLayoutButton(h),
      showAllCurvesButton(model.isShowingAllCurves, h),
      clearPinsButton(model.pins, h),
    ],
  });
  const alertOnly = (error: string): TraceParts => ({
    screen: [],
    toolbar: [alertView(error, h)],
  });
  const loading: TraceParts = { screen: [], toolbar: [loadingView(h)] };
  return AsyncData.match(model.trace, {
    onFailure: alertOnly,
    onIdle: () => loading,
    onLoading: () => loading,
    onRefreshing: loaded,
    onStale: ({ data, error }) => {
      const parts = loaded(data);
      return { screen: parts.screen, toolbar: Array.prepend(parts.toolbar, alertView(error, h)) };
    },
    onSuccess: loaded,
  });
};

/** A compact panel in the top left corner, over the canvas and outside its layer. */
const toolbarStyle = {
  background: "#ffffff",
  border: "1px solid #cbd5e1",
  "border-radius": "8px",
  "box-shadow": "0 2px 8px rgba(15, 23, 42, 0.15)",
  "box-sizing": "border-box",
  left: `${TOOLBAR_MARGIN}px`,
  "max-width": "calc(100vw - 24px)",
  padding: "8px 12px",
  position: "fixed",
  top: `${TOOLBAR_MARGIN}px`,
  width: `${TOOLBAR_WIDTH}px`,
  "z-index": "20",
};

export const view = (model: Model, h: HtmlBuilder<Message>): Document =>
  Screen.match(model.screen, {
    Canvas: () => canvasScreenView(model, h),
    Reader: () => readerScreenView(model, h),
    Code: (code) => ({
      body: h.main(
        [],
        Option.match(AsyncData.getData(model.trace), {
          onNone: () => [loadingView(h)],
          onSome: (trace) => [
            codeView(trace, code, model.patches, model.diffStyle, h, codeMessages),
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

const canvasScreenView = (model: Model, h: HtmlBuilder<Message>): Document => {
  const others = othersOf(model);
  const parts = traceParts(model, others, h);
  return {
    body: h.main(
      // The canvas is fixed over the page, so main has no height of its own: it fills the screen
      // for light-only's paper to cover the page's dark one.
      [h.Class("light-only"), h.Style({ "min-height": "100vh" })],
      Array.prepend(
        parts.screen,
        h.header(
          [h.DataAttribute("toolbar", ""), h.Style(toolbarStyle)],
          Array.flatten([
            [
              h.h1([h.Style({ "font-size": "16px", margin: "0 0 4px" })], ["Cairn"]),
              h.p(
                [h.Role("status"), h.Style({ margin: "0 0 8px" })],
                [presenceText(model, others)],
              ),
            ],
            Array.map(Array.fromOption(model.maybePanZoomFailure), (reason) =>
              alertView(`Pan and zoom are unavailable: ${reason}`, h),
            ),
            [screenSwitchView("Canvas", h)],
            parts.toolbar,
          ]),
        ),
      ),
    ),
    title: "Cairn",
  };
};
