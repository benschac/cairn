// The Foldkit copy of a view that has moved to Effect UI, for the views still on Foldkit, which
// render under the bridge (`spec.viewer.effect-ui.views`). Delete it in the change that moves its
// last importer: `rg -l "foldkit/<this file>" apps/viewer/src`.

import { Array, type Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { PassageButton } from "../links.ts";
import { Message } from "../message.ts";
import { PASSAGE_TOO_LONG, copyLabelOf, type CopyLink } from "../view/copyLinkView.ts";

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

/** A Copy link button that reads "copied" while its path is the one last copied. */
export const copyButtonView = (
  maybeCopied: Option.Option<string>,
  path: string,
  label: string,
  h: HtmlBuilder<Message>,
): Html => copyLinkView({ label: copyLabelOf(maybeCopied, path, label), path }, h);
