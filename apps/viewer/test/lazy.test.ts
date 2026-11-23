import { it } from "@effect/vitest";
import { Array, Option } from "effect";
import { Lazy } from "foldkit/test";
import { modifyFields } from "foldkit/struct";
import { expect } from "vitest";

import { demoTrace } from "../src/demo.ts";
import { Drawer } from "../src/model.ts";
import type { Node } from "../src/trace.ts";
import { loaded, sequence } from "./fixtures.ts";

const hovered: Node = Option.getOrThrow(
  Option.map(Array.head(demoTrace.tasks), (task): Node => ({ id: task.id, kind: "task" })),
);

/** The model a frame into a drag. */
const frame = (x: number) => modifyFields(loaded, { viewport: () => ({ x, y: x, zoom: 1 + x }) });

it("a pan or zoom reuses the columns instead of parsing the markdown again", () => {
  expect(() =>
    Lazy.expectAllReused({ model: loaded, view: sequence([frame(0), frame(1)]) }),
  ).not.toThrow();
});

it("a pan with a drawer open reuses the columns", () => {
  const open = modifyFields(loaded, {
    drawer: () => Drawer.Open({ node: hovered }),
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

/** The model a frame into a drag of the PRD and a task card. */
const moved = (x: number) =>
  modifyFields(loaded, {
    offsets: () => ({ "document:prd": { x, y: 0 }, "task:t9": { x, y: x } }),
  });

it("a drag frame reuses both documents and rebuilds only the stacks", () => {
  // One miss is the stacks, which take the offsets; the two document bodies are reused.
  expect(() =>
    Lazy.expectAllReused({ model: loaded, view: sequence([moved(0), moved(1)]) }),
  ).toThrow("1 lazy cache miss on the second render");
});
