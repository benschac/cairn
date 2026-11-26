import type { Html } from "@effect/ui/html";

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
  h: Html.H<Message>,
  text: string,
  messages: LinkNoticeMessages<Message>,
) =>
  h.div
    .class("link-notice")
    .attr("role", "status")
    .attr("data-link-notice", "")
    .children(
      h.p(text),
      h.button
        .attr("type", "button")
        .class("btn")
        .on("click", messages.onDismiss)
        .children("Dismiss"),
    );
