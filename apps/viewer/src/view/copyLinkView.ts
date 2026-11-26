import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { Message } from "../message.ts";

/** What a Copy link button copies and what it says. */
export interface CopyLink {
  readonly label: string;
  /** The link's path, which the update writes after the page's origin. */
  readonly path: string;
}

/**
 * A Copy link button: its click sends the path, and the update writes it to the clipboard. The
 * caller chooses the label, so a button reads "copied" once the clipboard took its path (see
 * `copyLabelOf`).
 */
export const copyLinkView = ({ label, path }: CopyLink, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class("btn"),
      h.DataAttribute("copy-link", path),
      h.OnClick(Message.ClickedCopyLink({ path })),
    ],
    [label],
  );

/** A Copy link button that reads "copied" while its path is the one last copied. */
export const copyButtonView = (
  maybeCopied: Option.Option<string>,
  path: string,
  label: string,
  h: HtmlBuilder<Message>,
): Html => copyLinkView({ label: copyLabelOf(maybeCopied, path, label), path }, h);

/** The button's label: "copied" while its path is the one last copied, `label` otherwise. */
export const copyLabelOf = (
  maybeCopied: Option.Option<string>,
  path: string,
  label: string,
): string => (Option.contains(maybeCopied, path) ? "copied" : label);
