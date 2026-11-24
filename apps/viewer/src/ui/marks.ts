import type { SectionStatus } from "@cairn/contract";
import type { Html, HtmlBuilder } from "foldkit/html";

/**
 * What a tag names: a PRD or a spec section, a task ID or a short SHA. `components.css` fills a
 * PRD tag and a spec tag; a task ID and a SHA are `--raised`.
 */
export type TagKind = "prd" | "spec" | "task" | "sha";

/**
 * The marks that only show something, each a function of its data and `h`. The look is in
 * `components.css`, chosen from the attribute each mark carries.
 */

/** A task's or a section's status as a round mark; `data-status` is what the stylesheet colours. */
export const dotView = <Message>(status: SectionStatus, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("dot"), h.DataAttribute("status", status), h.AriaHidden(true)]);

/** A task ID, a short SHA, or `SPEC` or `PRD` in a card's header; `data-kind` is its fill. */
export const tagView = <Message>(kind: TagKind, text: string, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("tag"), h.DataAttribute("kind", kind)], [text]);

/** `GATE`, on a task that waits for a human. */
export const gateView = <Message>(h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("gate")], ["GATE"]);

/** The small uppercase heading over a pane or a legend. */
export const labelView = <Message>(text: string, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("label")], [text]);
