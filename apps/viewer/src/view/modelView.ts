import type { Reasoning } from "@cairn/contract";
import { Array, Match } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

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

/** What every size carries: the model's name for its colour, and whether it ran for its border. */
export const modelAttributesOf = <Message>(
  ran: Ran,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Attribute<Message>> => [
  h.DataAttribute("model", ran.model),
  h.DataAttribute("ran", `${ran.ran}`),
];

/** `sonnet · medium`, at the end of a task row. */
export const modelChipView = <Message>(ran: Ran, h: HtmlBuilder<Message>): Html =>
  h.span(
    Array.appendAll(
      [h.Class("chip"), h.DataAttribute("model-chip", ""), h.Title(modelTitleOf(ran))],
      modelAttributesOf(ran, h),
    ),
    [`${ran.model} · ${ran.reasoning}`],
  );

/** The `lo`, `med`, `hi`, `xhi` or `max` that follows a stack chip's ID. */
export const modelMarkView = <Message>(ran: Ran, h: HtmlBuilder<Message>): Html =>
  h.span(
    [
      h.DataAttribute("model-mark", ""),
      h.Title(modelTitleOf(ran)),
      h.Style({ "font-size": "var(--t-xs)" }),
    ],
    [reasoningMarkOf(ran.reasoning)],
  );

/** One small square in a spec card's header, for one task. */
export const modelSquareView = <Message>(ran: Ran, h: HtmlBuilder<Message>): Html =>
  h.span(
    Array.appendAll(
      [h.Class("swatch"), h.DataAttribute("model-square", ""), h.Title(modelTitleOf(ran))],
      modelAttributesOf(ran, h),
    ),
  );
