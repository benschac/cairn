// The Foldkit copy of a view that has moved to Effect UI, for the views still on Foldkit, which
// render under the bridge (`spec.viewer.effect-ui.views`). Delete it in the change that moves its
// last importer: `rg -l "foldkit/<this file>" apps/viewer/src`.

import type { SectionStatus } from "@cairn/contract";
import { Array } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Rendered } from "../markdown.ts";
import type { TagKind } from "../ui/marks.ts";

/**
 * The marks that only show something, each a function of its data and `h`. The look is in
 * `components.css`, chosen from the attribute each mark carries.
 */

/** A task's or a section's status as a round mark; `data-status` is what the stylesheet colours. */
export const dotView = <Message>(status: SectionStatus, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("dot"), h.DataAttribute("status", status), h.AriaHidden(true)]);

/**
 * A task ID, a short SHA, or `SPEC` or `PRD` in a card's header; `data-kind` is its fill. The text
 * is a string, or rendered nodes when a search marked part of it.
 */
export const tagView = <Message>(
  kind: TagKind,
  text: string | Rendered,
  h: HtmlBuilder<Message>,
): Html => h.span([h.Class("tag"), h.DataAttribute("kind", kind)], Array.ensure(text));

/** `GATE`, on a task that waits for a human. */
export const gateView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("gate")], ["GATE"]);

/** The small uppercase heading over a pane or a legend. */
export const labelView = <Message>(text: string, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("label")], [text]);
