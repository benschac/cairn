import type { Reasoning } from "@cairn/contract";
import type { Html } from "@effect/ui/html";
import { Match } from "effect";

import { styleText, type Attributable } from "../effect-ui/attributes.ts";
import type { Ran } from "../reader.ts";

/** The short mark for a reasoning level, as the PRD names them. */
export const reasoningMarkOf = (reasoning: Reasoning): string =>
  Match.value(reasoning).pipe(
    Match.when("low", () => "lo"),
    Match.when("medium", () => "med"),
    Match.when("high", () => "hi"),
    Match.when("xhigh", () => "xhi"),
    Match.when("max", () => "max"),
    Match.exhaustive,
  );

/** "Ran on sonnet, medium reasoning" or "Planned for sonnet, medium reasoning". */
export const modelTitleOf = (ran: Ran): string =>
  `${ran.ran ? "Ran on" : "Planned for"} ${ran.model}, ${ran.reasoning} reasoning`;

/**
 * What every size carries: the model's name for its colour, and whether it ran for its border.
 * It adds them to the builder it is given and returns that builder.
 */
export const withModel = <B>(builder: B & Attributable<B>, ran: Ran): B =>
  builder.attrs({ "data-model": ran.model, "data-ran": `${ran.ran}` });

/** `sonnet · medium`, at the end of a task row. */
export const modelChipView = <Msg>(h: Html.H<Msg>, ran: Ran) =>
  withModel(
    h.span.class("chip").attr("data-model-chip", "").attr("title", modelTitleOf(ran)),
    ran,
  ).children(`${ran.model} · ${ran.reasoning}`);

/** The `lo`, `med`, `hi`, `xhi` or `max` that follows a stack chip's ID. */
export const modelMarkView = <Msg>(h: Html.H<Msg>, ran: Ran) =>
  h.span
    .attr("data-model-mark", "")
    .attr("title", modelTitleOf(ran))
    .attr("style", styleText({ "font-size": "var(--t-xs)" }))
    .children(reasoningMarkOf(ran.reasoning));

/** One small square in a spec card's header, for one task. */
export const modelSquareView = <Msg>(h: Html.H<Msg>, ran: Ran) =>
  withModel(
    h.span.class("swatch").attr("data-model-square", "").attr("title", modelTitleOf(ran)),
    ran,
  );
