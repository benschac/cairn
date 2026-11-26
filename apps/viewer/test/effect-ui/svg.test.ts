import { UiSchema } from "@effect/ui";
import { Html, HtmlServer } from "@effect/ui/html";
import { HtmlScene } from "@effect/ui/html/testing";
import { Locator } from "@effect/ui/testing";
import { assert, it } from "@effect/vitest";
import { Effect, Schema, String } from "effect";

import { svgFor } from "../../src/effect-ui/svg.ts";

const Message = UiSchema.TaggedEnum({
  ClickedNode: { id: Schema.String },
});
type Message = typeof Message.Type;

const Model = Schema.Struct({ sent: Schema.String });

const svg = svgFor<Message>();

const Drawing = Html.component({
  message: Message,
  model: Model,
  name: "Drawing",
  props: Schema.Struct({}),
}).make({
  init: (): typeof Model.Type => ({ sent: "" }),
  update: { ClickedNode: ($, { id }) => $.evolve({ sent: `ClickedNode ${id}` }) },
  view: (h, model) =>
    h.main.children(
      svg.svg
        .attr("viewBox", "0 0 100 40")
        .attr("aria-label", "Graph")
        .children(
          svg.defs.children(svg.marker.attr("id", "head").children(svg.path.attr("d", "M0 0L4 2"))),
          svg.g
            .key("edges")
            .class("edges")
            .children(
              svg.line
                .attr("x1", "10")
                .attr("y1", "20")
                .attr("x2", "90")
                .attr("y2", "20")
                .attr("marker-end", "url(#head)"),
            ),
          svg.circle
            .key("a")
            .attr("cx", "10")
            .attr("cy", "20")
            .attr("r", "6")
            .attr("aria-label", "Node a")
            .style({ fill: "red" })
            .on("click", () => Message.ClickedNode({ id: "a" })),
          svg.text.attr("x", "20").children("a"),
        ),
      h.p.id("sent").children(model.sent),
    ),
});

const node = Locator.attr("aria-label", "Node a");
const sent = Locator.attr("id", "sent");

it.effect("an SVG view keeps its tags, attributes and classes, and a click sends its Message", () =>
  Effect.gen(function* () {
    const s = yield* HtmlScene.make(Drawing, {});
    assert.strictEqual(s.get(node).tag, "circle");
    s.expect(node)
      .toHaveAttribute("r", "6")
      .expect(Locator.attr("class", "edges"))
      .toHaveCount(1)
      .expect(sent)
      .toHaveText("")
      .click(node)
      .expect(sent)
      .toHaveText("ClickedNode a");
  }),
);

it.effect(
  "the server serializes the tags as SVG: the case of viewBox kept, shapes self-closed",
  () =>
    Effect.gen(function* () {
      const { html } = yield* HtmlServer.renderToHtml(Drawing, {});
      assert.isTrue(String.includes('viewBox="0 0 100 40"')(html));
      assert.isTrue(String.includes("<path")(html));
      assert.isTrue(String.includes("<line")(html));
      assert.isTrue(String.includes("</svg>")(html));
      assert.isFalse(String.includes("<svg>")(html));
    }),
);
