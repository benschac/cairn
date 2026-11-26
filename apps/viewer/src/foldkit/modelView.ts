// The Foldkit copy of a view that has moved to Effect UI, for the views still on Foldkit, which
// render under the bridge (`spec.viewer.effect-ui.views`). Delete it in the change that moves its
// last importer: `rg -l "foldkit/<this file>" apps/viewer/src`.

import { Array } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import type { Ran } from "../reader.ts";
import { modelTitleOf, reasoningMarkOf } from "../view/modelView.ts";

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
