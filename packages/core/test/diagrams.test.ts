import { expect, it } from "@effect/vitest";
import { Array, Option, Schema, String, pipe } from "effect";

import { drawsOf } from "../src/index.ts";

const NodeId = Schema.Literals(["a", "b", "c", "d", "e"]);
const Direction = Schema.Literals(["TD", "LR", "BT", "RL"]);
const Edges = Schema.Array(Schema.Tuple([NodeId, NodeId])).check(Schema.isMinLength(1));

const flowchart = (direction: string, edges: ReadonlyArray<readonly [string, string]>): string =>
  pipe(
    edges,
    Array.map(([from, to]) => `  ${from} --> ${to}`),
    Array.join("\n"),
    (body) => `flowchart ${direction}\n${body}`,
  );

it.prop(
  "a flowchart of edges between known nodes draws",
  { direction: Direction, edges: Edges },
  ({ direction, edges }) => {
    expect(drawsOf(flowchart(direction, edges))).toEqual(Option.none());
  },
);

it.prop(
  "a flowchart whose last edge is cut short returns the parser's error",
  { direction: Direction, edges: Edges },
  ({ direction, edges }) => {
    const error = drawsOf(`${flowchart(direction, edges)}\n  a --`);
    expect(Option.isSome(error)).toBe(true);
    expect(pipe(error, Option.map(String.isNonEmpty))).toEqual(Option.some(true));
  },
);

it("draws a state diagram and a sequence diagram", () => {
  expect(drawsOf("stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start")).toEqual(
    Option.none(),
  );
  expect(drawsOf("sequenceDiagram\n  A->>B: hello")).toEqual(Option.none());
});

it("returns an error for text that is no diagram, and for an empty block", () => {
  expect(Option.isSome(drawsOf("not a diagram"))).toBe(true);
  expect(Option.isSome(drawsOf(""))).toBe(true);
});
