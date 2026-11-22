import { it } from "@effect/vitest";
import { Array, Option } from "effect";
import type { Document, HtmlBuilder } from "foldkit/html";
import { Lazy } from "foldkit/test";
import { modifyFields } from "foldkit/struct";
import { expect } from "vitest";

import { demoTrace } from "../src/demo.ts";
import type { Message } from "../src/message.ts";
import { Drawer, type Model } from "../src/model.ts";
import type { Node } from "../src/trace.ts";
import { view } from "../src/view/view.ts";
import { loaded } from "./fixtures.ts";

const hovered: Node = Option.getOrThrow(
  Option.map(Array.head(demoTrace.tasks), (task): Node => ({ id: task.id, kind: "task" })),
);

/**
 * `Lazy.expectAllReused` renders twice with the same Model; this view hands each render the next
 * Model of a sequence, so the second render is one frame later in a drag.
 */
const sequence = (models: ReadonlyArray<Model>) => {
  let render = 0;
  return (_model: Model, h: HtmlBuilder<Message>): Document => {
    const model = Option.getOrThrow(Array.get(models, render % models.length));
    render += 1;
    return view(model, h);
  };
};

/** The model a frame into a drag. */
const frame = (x: number) => modifyFields(loaded, { viewport: () => ({ x, y: x, zoom: 1 + x }) });

it("a pan or zoom reuses the columns instead of parsing the markdown again", () => {
  expect(() =>
    Lazy.expectAllReused({ model: loaded, view: sequence([frame(0), frame(1)]) }),
  ).not.toThrow();
});

it("a pan with a drawer open reuses the columns", () => {
  const open = modifyFields(loaded, {
    drawer: () => Drawer.Open({ maybeCommitSha: Option.none(), node: hovered }),
  });
  const openFrame = (x: number) =>
    modifyFields(open, { viewport: () => ({ x, y: x, zoom: 1 + x }) });
  expect(() =>
    Lazy.expectAllReused({ model: open, view: sequence([openFrame(0), openFrame(1)]) }),
  ).not.toThrow();
});

it("changing the hovered node rebuilds the columns", () => {
  const hover = modifyFields(loaded, { maybeHovered: () => Option.some(hovered) });
  expect(() => Lazy.expectAllReused({ model: loaded, view: sequence([loaded, hover]) })).toThrow(
    "ArgumentsChanged",
  );
});
