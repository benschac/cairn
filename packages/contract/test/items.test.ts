import { expect, it } from "@effect/vitest";
import { Array, Result, Schema } from "effect";

import {
  IndexedTask,
  PrdSectionId,
  SpecIndex,
  SpecSectionId,
  StatementId,
  TestId,
  Trace,
  TraceDocument,
  TraceItem,
  TraceStatement,
  TraceTask,
  ownerOf,
  parseTrailers,
} from "../src/index.ts";

const isStatement = Schema.is(StatementId);

it("a statement id is a PRD section or item id, #v and a version from 1", () => {
  expect(isStatement("prd.saved-views#v1")).toBe(true);
  expect(isStatement("prd.cli.lint#v12")).toBe(true);
  expect(isStatement("spec.x#v1")).toBe(false);
  expect(isStatement("prd.x#v0")).toBe(false);
  expect(isStatement("prd.x#t1")).toBe(false);
  expect(isStatement("prd.x")).toBe(false);
});

it("a test id is a spec section id, #t and a number from 1", () => {
  expect(Schema.is(TestId)("spec.format#t1")).toBe(true);
  expect(Schema.is(TestId)("spec.format#t0")).toBe(false);
  expect(Schema.is(TestId)("prd.format#t1")).toBe(false);
  expect(Schema.is(TestId)("spec.format#v1")).toBe(false);
});

it.prop(
  "ownerOf returns what comes before #v and the owner decodes as a PRD id",
  [PrdSectionId],
  ([owner]) => {
    const id = Schema.decodeSync(StatementId)(`${owner}#v3`);
    expect(ownerOf(id)).toBe(owner);
  },
);

it.prop("an item id decodes wherever a section id does", [PrdSectionId], ([id]) => {
  expect(Schema.is(TraceItem.fields.id)(id)).toBe(true);
  expect(Schema.is(Schema.Array(PrdSectionId))([id])).toBe(true);
});

it.prop(
  "a trace document without items or statements decodes with empty arrays",
  [TraceDocument],
  ([document]) => {
    const {
      items: _items,
      statements: _statements,
      ...old
    } = Schema.encodeSync(TraceDocument)(document);
    const decoded = Schema.decodeUnknownSync(TraceDocument)(old);
    expect(decoded.items).toEqual([]);
    expect(decoded.statements).toEqual([]);
  },
);

it.prop("a task without statements decodes with none", [TraceTask], ([task]) => {
  const { statements: _statements, ...old } = Schema.encodeSync(TraceTask)(task);
  expect(Schema.decodeUnknownSync(TraceTask)(old).statements).toEqual([]);
});

it.prop(
  "a spec index without tasks or proves decodes with empty arrays",
  [SpecIndex],
  ([index]) => {
    const { tasks: _tasks, ...encoded } = Schema.encodeSync(SpecIndex)(index);
    const old = {
      ...encoded,
      sections: Array.map(encoded.sections, (section) => ({
        ...section,
        tests: Array.map(section.tests, ({ proves: _proves, ...test }) => test),
      })),
    };
    const decoded = Schema.decodeUnknownSync(SpecIndex)(old);
    expect(decoded.tasks).toEqual([]);
    expect(
      Array.every(decoded.sections, (s) =>
        Array.every(s.tests, (t) => Array.isReadonlyArrayEmpty(t.proves)),
      ),
    ).toBe(true);
  },
);

it.prop(
  "items, statements and indexed tasks round-trip",
  [TraceItem, TraceStatement, IndexedTask],
  ([item, statement, task]) => {
    expect(Schema.decodeSync(TraceItem)(Schema.encodeSync(TraceItem)(item))).toEqual(item);
    expect(Schema.decodeSync(TraceStatement)(Schema.encodeSync(TraceStatement)(statement))).toEqual(
      statement,
    );
    expect(Schema.decodeSync(IndexedTask)(Schema.encodeSync(IndexedTask)(task))).toEqual(task);
  },
);

it("a statement's provedBy refuses an id that is not a test id", () => {
  const statement = {
    draft: false,
    human: false,
    id: "prd.a#v1",
    line: 1,
    owner: "prd.a",
    provedBy: ["spec.a#t1"],
    text: "x",
  };
  expect(Schema.is(TraceStatement)(Schema.decodeUnknownSync(TraceStatement)(statement))).toBe(true);
  expect(
    Schema.is(Schema.toEncoded(TraceStatement))({ ...statement, provedBy: ["spec.a#r1"] }),
  ).toBe(false);
});

it("a Cairn-Section trailer can name a PRD item, and round-trips with spec sections", () => {
  const message =
    "Build\n\nCairn-Task: t1\nCairn-Section: prd.cli.lint\nCairn-Section: spec.cli.lint\nCairn-Session: s_abcdef";
  const parsed = parseTrailers(message);
  expect(Result.isSuccess(parsed)).toBe(true);
  expect(Result.getOrThrow(parsed).sections).toEqual(["prd.cli.lint", "spec.cli.lint"]);
  expect(Schema.is(SpecSectionId)("prd.cli.lint")).toBe(false);
});

it.prop("a whole trace still decodes through the contract", [Trace], ([trace]) => {
  expect(Schema.decodeSync(Trace)(Schema.encodeSync(Trace)(trace))).toEqual(trace);
});
