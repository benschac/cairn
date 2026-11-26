import { SpecSectionId } from "@cairn/contract";
import type { BodyHash, IndexedSection, SpecIndex } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Option, Record, Result, Schema, String } from "effect";

import {
  STACKS_CLOSE,
  STACKS_OPEN,
  bodyHashOf,
  derivedOf,
  readHashOf,
  sectionsOf,
} from "../src/index.ts";

const PRD = "# Product {#prd.product}\n";
const decodeId = Schema.decodeSync(SpecSectionId);

/** For each section, the sections it depends on, as positions that wrap around the spec. */
const Picks = Schema.Array(
  Schema.Array(Schema.Int.check(Schema.isBetween({ maximum: 7, minimum: 0 }))).check(
    Schema.isMaxLength(3),
  ),
).check(Schema.isMinLength(1), Schema.isMaxLength(8));

const dependenciesOf = (picks: typeof Picks.Type, at: number): ReadonlyArray<string> =>
  Array.dedupe(
    Array.map(
      Option.getOrElse(Array.get(picks, at), (): ReadonlyArray<number> => []),
      (pick) => `spec.s${pick % Array.length(picks)}`,
    ),
  );

/**
 * A spec of sections `spec.s0`, `spec.s1`…, each saying `text(at)`. Section `at` depends on the
 * sections its picks name and on `spec.gone`, which the spec does not have.
 */
const specOf = (picks: typeof Picks.Type, text: (at: number) => string): string =>
  Array.join(
    Array.map(picks, (_deps, at) => {
      const named = Array.map(
        Array.append(dependenciesOf(picks, at), "spec.gone"),
        (id) => `\`${id}\``,
      );
      return `## Section ${at} {#spec.s${at}}\n\n- Depends on: ${Array.join(named, ", ")}\n\n${text(at)}\n`;
    }),
    "\n",
  );

const first = (at: number) => `Text ${at}.`;
const later = (at: number) => `Text ${at}, changed.`;

/** The hash of what is read of each section of `spec`, by ID. */
const hashesOf = (spec: string): Record.ReadonlyRecord<string, BodyHash> =>
  Record.fromEntries(
    Array.filterMap(sectionsOf(spec), (section) =>
      Option.match(Option.fromUndefinedOr(section.id), {
        onNone: () => Result.failVoid,
        onSome: (id) => Result.succeed([id, readHashOf(section.body)] as const),
      }),
    ),
  );

/** What section `at` records of the sections it depends on, when they are as `spec` has them. */
const expectedOf = (picks: typeof Picks.Type, spec: string, at: number) => {
  const hashes = hashesOf(spec);
  return Record.fromEntries(
    Array.filterMap(dependenciesOf(picks, at), (id) =>
      Option.match(Record.get(hashes, id), {
        onNone: () => Result.failVoid,
        onSome: (hash) => Result.succeed([id, hash] as const),
      }),
    ),
  );
};

const indexOf = (
  spec: string,
  written: ReadonlyArray<SpecSectionId>,
  previous: Option.Option<SpecIndex>,
): SpecIndex => ({
  manifest: ".cairn/manifest.json",
  prd: ".cairn/prd.md",
  sections: Array.map(
    derivedOf({ manifest: { tasks: [] }, prd: PRD, previous, spec, written }),
    (derived): IndexedSection => ({
      ...derived,
      artifacts: [],
      decisions: [],
      requirements: [],
      summary: "",
      tests: [],
    }),
  ),
  source: ".cairn/spec.md",
  tasks: [],
  version: 1,
});

it.prop(
  "a section records the hash of each section it depends on that exists, and of nothing else",
  [Picks],
  ([picks]) => {
    const spec = specOf(picks, first);
    const index = indexOf(spec, [], Option.none());
    expect(Array.map(index.sections, (section) => section.writtenFrom.spec)).toEqual(
      Array.map(picks, (_deps, at) => expectedOf(picks, spec, at)),
    );
  },
);

it.prop(
  "what a section was written from stays as it was when the sections it depends on change, until it is written again",
  [Picks, Schema.Int.check(Schema.isBetween({ maximum: 7, minimum: 0 }))],
  ([picks, pick]) => {
    const before = specOf(picks, first);
    const after = specOf(picks, later);
    const rewritten = pick % Array.length(picks);
    const written = indexOf(before, [], Option.none());
    const kept = indexOf(after, [], Option.some(written));
    const again = indexOf(after, [decodeId(`spec.s${rewritten}`)], Option.some(written));
    expect(Array.map(kept.sections, (section) => section.writtenFrom)).toEqual(
      Array.map(written.sections, (section) => section.writtenFrom),
    );
    expect(Array.map(again.sections, (section) => section.writtenFrom.spec)).toEqual(
      Array.map(picks, (_deps, at) => expectedOf(picks, at === rewritten ? after : before, at)),
    );
  },
);

/** A spec whose first section holds `diagram` between the stack diagram's markers, and whose second depends on it. */
const drawn = (diagram: string) =>
  `## One {#spec.one}\n\nAbove.\n\n${STACKS_OPEN}\n${diagram}\n${STACKS_CLOSE}\n\n## Two {#spec.two}\n\n- Depends on: \`spec.one\`\n\nText.\n`;

/** What each section of `spec` records of the sections it depends on. */
const recorded = (spec: string) =>
  Array.map(indexOf(spec, [], Option.none()).sections, (section) => section.writtenFrom.spec);

it("the hash recorded for a section that holds the stack diagram does not depend on the diagram", () => {
  expect(recorded(drawn("first"))).toEqual(recorded(drawn("second, and longer")));
  expect(recorded(drawn("first"))).not.toEqual(
    recorded(String.replace("Above.", "Below.")(drawn("first"))),
  );
  // It is not the hash of the whole body, which the diagram is part of.
  const [one] = sectionsOf(drawn("first"));
  expect(recorded(drawn("first"))[1]).not.toEqual({ "spec.one": bodyHashOf(one?.body ?? "") });
});
