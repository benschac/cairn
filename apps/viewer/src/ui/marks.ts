import type { SectionStatus } from "@cairn/contract";
import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";

/**
 * What a tag names: a PRD or a spec section, a task ID or a short SHA. `components.css` fills a
 * PRD tag and a spec tag; a task ID and a SHA are `--raised`.
 */
export type TagKind = "prd" | "spec" | "task" | "sha";

/**
 * The marks that only show something, each a function of `h` and its data. The look is in
 * `components.css`, chosen from the attribute each mark carries. The views still on Foldkit use
 * `foldkit/marks.ts`.
 */

/** A task's or a section's status as a round mark; `data-status` is what the stylesheet colours. */
export const dotView = <Msg>(h: Html.H<Msg>, status: SectionStatus) =>
  h.span.class("dot").attr("data-status", status).attr("aria-hidden", "true");

/**
 * A task ID, a short SHA, or `SPEC` or `PRD` in a card's header; `data-kind` is its fill. The text
 * is a string, or the marked nodes when a search matched part of it.
 */
export const tagView = <Msg>(h: Html.H<Msg>, kind: TagKind, text: View.Input<Msg>) =>
  h.span.class("tag").attr("data-kind", kind).children(text);

/** `GATE`, on a task that waits for a human. */
export const gateView = <Msg>(h: Html.H<Msg>) => h.span.class("gate").children("GATE");

/** The small uppercase heading over a pane or a legend. */
export const labelView = <Msg>(h: Html.H<Msg>, text: string) =>
  h.span.class("label").children(text);
