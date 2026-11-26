import type { SectionId } from "@cairn/contract";
import type { Html } from "@effect/ui/html";
import { Option } from "effect";

import type { PassageButton } from "../links.ts";
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
export const copyLinkView = (h: Html.H<Message>, { label, path }: CopyLink) =>
  h.button
    .attr("type", "button")
    .class("btn")
    .attr("data-copy-link", path)
    .on("click", Message.ClickedCopyLink({ path }))
    .children(label);

/** The words a disabled "Copy link to passage" gives for its reason. */
export const PASSAGE_TOO_LONG = "Select at most 500 characters to link to them.";

/**
 * "Copy link to passage": opens the selected passage as a step and copies the link up to it.
 * A selection over the limit disables it, with the reason as its title.
 */
export const copyPassageView = (h: Html.H<Message>, { isOverLimit, section }: PassageButton) =>
  h.button
    .attr("type", "button")
    .class("btn")
    .attr("data-copy-passage", section)
    .on("click", Message.ClickedCopyPassageLink({ section }))
    .disabled(isOverLimit)
    .attr("title", isOverLimit ? PASSAGE_TOO_LONG : undefined)
    .children("Copy link to passage");

/**
 * The passage button of the section `id`, when the selection is inside it. A pane is given the
 * selected section and whether it is over the limit as plain values, so a pane that memoizes its
 * body is not rebuilt while the selection grows.
 */
export const passageButtonFor = (
  selectedSection: string,
  isOverLimit: boolean,
  id: SectionId,
): Option.Option<PassageButton> =>
  selectedSection === id ? Option.some({ isOverLimit, section: id }) : Option.none();

/** A Copy link button that reads "copied" while its path is the one last copied. */
export const copyButtonView = (
  h: Html.H<Message>,
  maybeCopied: Option.Option<string>,
  path: string,
  label: string,
) => copyLinkView(h, { label: copyLabelOf(maybeCopied, path, label), path });

/** The button's label: "copied" while its path is the one last copied, `label` otherwise. */
export const copyLabelOf = (
  maybeCopied: Option.Option<string>,
  path: string,
  label: string,
): string => (Option.contains(maybeCopied, path) ? "copied" : label);
