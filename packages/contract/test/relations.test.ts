import { expect, it } from "@effect/vitest";
import { Array, Record, Result, Schema, Struct } from "effect";

import { EndKind, Manifest, Relation, RelationKind, relationKinds } from "../src/index.ts";

const decode = Schema.decodeUnknownResult(Relation);

it("declares the eight kinds", () => {
  expect(Record.size(relationKinds)).toBe(8);
});

it.prop("every kind has a non-empty from and to", [RelationKind], ([kind]) => {
  expect(Array.isReadonlyArrayNonEmpty(relationKinds[kind].from)).toBe(true);
  expect(Array.isReadonlyArrayNonEmpty(relationKinds[kind].to)).toBe(true);
});

it.prop(
  "Relation accepts exactly the ends its kind declares",
  [RelationKind, EndKind, EndKind],
  ([kind, from, to]) => {
    const declared = relationKinds[kind];
    const allowed = Array.contains(declared.from, from) && Array.contains(declared.to, to);
    const result = decode({ from: { id: "x", kind: from }, kind, to: { id: "y", kind: to } });
    expect(Result.isSuccess(result)).toBe(allowed);
  },
);

it("proves runs from a test to a statement", () => {
  expect(
    Result.isSuccess(
      decode({
        from: { id: "spec.a#t1", kind: "test" },
        kind: "proves",
        to: { id: "prd.a#v1", kind: "statement" },
      }),
    ),
  ).toBe(true);
});

it.prop("an old manifest decodes with an empty orderedAfter", [Manifest], ([manifest]) => {
  const encoded = Schema.encodeSync(Manifest)(manifest);
  const old = {
    ...encoded,
    tasks: Array.map(encoded.tasks, Struct.omit(["orderedAfter"])),
  };
  const decoded = Schema.decodeUnknownSync(Manifest)(old);
  expect(Array.every(decoded.tasks, (t) => Array.isReadonlyArrayEmpty(t.orderedAfter))).toBe(true);
});
