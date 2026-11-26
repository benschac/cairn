import type { SectionId } from "@cairn/contract";
import { Array, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

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

/** The words a disabled "Copy link to passage" gives for its reason. */
export const PASSAGE_TOO_LONG = "Select at most 500 characters to link to them.";

/**
 * "Copy link to passage": opens the selected passage as a step and copies the link up to it.
 * A selection over the limit disables it, with the reason as its title.
 */
export const copyPassageView = (
  { isOverLimit, section }: PassageButton,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    Array.appendAll(
      [
        h.Type("button"),
        h.Class("btn"),
        h.DataAttribute("copy-passage", section),
        h.OnClick(Message.ClickedCopyPassageLink({ section })),
      ],
      isOverLimit ? [h.Disabled(true), h.Title(PASSAGE_TOO_LONG)] : [],
    ),
    ["Copy link to passage"],
  );

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
