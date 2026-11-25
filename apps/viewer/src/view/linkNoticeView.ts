import type { Html, HtmlBuilder } from "foldkit/html";

/** The message constructor the notice needs; the app supplies its own `ClickedDismissLinkNotice`. */
export interface LinkNoticeMessages<Message> {
  readonly onDismiss: Message;
}

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
