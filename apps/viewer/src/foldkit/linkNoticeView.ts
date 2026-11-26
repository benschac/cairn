// The Foldkit copy of a view that has moved to Effect UI, for the views still on Foldkit, which
// render under the bridge (`spec.viewer.effect-ui.views`). Delete it in the change that moves its
// last importer: `rg -l "foldkit/<this file>" apps/viewer/src`.

import type { Html, HtmlBuilder } from "foldkit/html";

import type { LinkNoticeMessages } from "../view/linkNoticeView.ts";

/**
 * The notice under the top bar of the reader and of the code view: how far a link opened and what
 * is missing, or why the address is not a link (see `noticeOf`). "Dismiss" takes it away; the
 * next link that opens replaces it.
 */
export const linkNoticeView = <Message>(
  text: string,
  h: HtmlBuilder<Message>,
  messages: LinkNoticeMessages<Message>,
): Html =>
  h.div(
    [h.Class("link-notice"), h.Role("status"), h.DataAttribute("link-notice", "")],
    [
      h.p([], [text]),
      // NOTE: a native button with Type("button"), as in the drawer. @foldkit/ui's Button.view
      // adds only Tabindex(0) over that, so it is not a dependency.
      h.button([h.Type("button"), h.Class("btn"), h.OnClick(messages.onDismiss)], ["Dismiss"]),
    ],
  );
