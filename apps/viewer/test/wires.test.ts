import { PrdSectionId, TaskId } from "@cairn/contract";
import { expect, it } from "@effect/vitest";
import { Array, Hash, Number, Option, Record, Schema, String, pipe } from "effect";

import { demoTrace } from "../src/demo.ts";
import type { Rect } from "../src/geometry.ts";
import { endKeyInOf, stackBoxesOf } from "../src/boxes.ts";
import { cardsOf } from "../src/reader.ts";
import { chainOf } from "../src/trace.ts";
import {
  type Panes,
  type Wire,
  isWireLit,
  linksOf,
  rowKey,
  segmentKey,
  specKey,
  taskKey,
  wiresOf,
} from "../src/wires.ts";

const prdIds = Array.map(demoTrace.prd.sections, (section) => PrdSectionId.make(section.id));
const Index = Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 }));
const Height = Schema.Int.check(Schema.isBetween({ maximum: 900, minimum: 16 }));
const Seed = Schema.Int.check(Schema.isBetween({ maximum: 100000, minimum: 0 }));

const prdAt = (index: number): PrdSectionId =>
  Option.getOrThrow(Array.get(prdIds, index % Array.length(prdIds)));

/** Three side-by-side panes, `height` tall. */
const panesOf = (height: number): Panes => ({
  prd: { height, width: 500, x: 0, y: 50 },
  spec: { height, width: 400, x: 500, y: 50 },
  stacks: { height, width: 300, x: 900, y: 50 },
});

const paneOf = (key: string, panes: Panes): Rect =>
  String.startsWith("prd:")(key)
    ? panes.prd
    : String.startsWith("task:")(key)
      ? panes.stacks
      : panes.spec;

const hashOf = (key: string, seed: number): number => (Hash.string(key) >>> 0) + seed;

/** A box for the key inside its pane across, anywhere along it down: often out of view. */
const boxOf = (key: string, seed: number, panes: Panes): Rect => {
  const pane = paneOf(key, panes);
  const n = hashOf(key, seed);
  return {
    height: 10 + (n % 60),
    width: 50 + (n % 100),
    x: pane.x + (n % 20),
    y: ((n * 37) % (pane.height + 600)) - 300 + pane.y,
  };
};

/** Whether the seed leaves the key unmeasured: about one in five. */
const isOmitted = (key: string, seed: number): boolean => hashOf(key, seed * 3) % 5 === 0;

const measured = (keys: ReadonlyArray<string>, seed: number, panes: Panes, omit: boolean) =>
  Record.fromEntries(
    Array.map(
      Array.filter(keys, (key) => !omit || !isOmitted(key, seed)),
      (key) => [key, boxOf(key, seed, panes)] as const,
    ),
  );

const keysOf = (links: ReadonlyArray<{ source: string; target: string }>) =>
  Array.dedupe(Array.flatMap(links, (link) => [link.source, link.target]));

/** The numbers in a path, in order. */
const numbersOf = (path: string): ReadonlyArray<number> =>
  Array.map(Array.fromIterable(String.matchAll(/-?\d+(?:\.\d+)?/g)(path)), (found) =>
    globalThis.Number(found[0]),
  );

it.prop("linksOf gives one link per card and one per row, strays included", [Index], ([index]) => {
  const prd = prdAt(index);
  const cards = cardsOf(demoTrace, prd);
  const links = linksOf(prd, cards);
  expect(Array.length(links)).toBe(
    Array.length(cards.cards) +
      Array.reduce(cards.cards, 0, (sum, card) => sum + Array.length(card.tasks)) +
      Array.length(cards.strays),
  );
  Array.forEach(cards.cards, (card) => {
    expect(links).toContainEqual({ source: `prd:${prd}`, target: specKey(card.section.id) });
    Array.forEach(card.tasks, (task) => {
      expect(links).toContainEqual({
        source: rowKey(card.section.id, task.id),
        target: taskKey(task.id),
      });
    });
  });
  Array.forEach(cards.strays, (task) => {
    expect(links).toContainEqual({ source: rowKey("_", task.id), target: taskKey(task.id) });
  });
});

it("the demo trace has a section with cards, so the properties are not vacuous", () => {
  expect(
    Array.some(prdIds, (prd) =>
      Array.isReadonlyArrayNonEmpty(linksOf(prd, cardsOf(demoTrace, prd))),
    ),
  ).toBe(true);
});

it.prop(
  "every wire's ends lie inside the rectangles of their panes, and its control points sit level with them",
  [Index, Height, Seed],
  ([index, height, seed]) => {
    const prd = prdAt(index);
    const panes = panesOf(height);
    const links = linksOf(prd, cardsOf(demoTrace, prd));
    const wires = wiresOf(links, measured(keysOf(links), seed, panes, false), panes);
    Array.forEach(wires, (wire) => {
      const [sx = NaN, sy = NaN, c1x, c1y, c2x, c2y, tx = NaN, ty = NaN] = numbersOf(wire.path);
      const target = paneOf(wire.target, panes);
      expect(tx).toBeGreaterThanOrEqual(target.x);
      expect(tx).toBeLessThanOrEqual(target.x + target.width);
      expect(ty).toBeGreaterThanOrEqual(target.y);
      expect(ty).toBeLessThanOrEqual(target.y + target.height);
      const source = paneOf(wire.source, panes);
      expect(sx).toBeGreaterThanOrEqual(source.x);
      expect(sx).toBeLessThanOrEqual(source.x + source.width);
      if (!String.startsWith("prd:")(wire.source)) {
        expect(sy).toBeGreaterThanOrEqual(source.y + 8);
        expect(sy).toBeLessThanOrEqual(source.y + source.height - 8);
      }
      expect(ty).toBeGreaterThanOrEqual(target.y + 8);
      expect(ty).toBeLessThanOrEqual(target.y + target.height - 8);
      const reach = Number.max(20, Math.abs(tx - sx) / 2);
      expect([c1x, c1y, c2x, c2y]).toEqual([sx + reach, sy, tx - reach, ty]);
    });
  },
);

it.prop(
  "a PRD end leaves the right edge of the PRD pane level with the heading, off the pane or not",
  [Index, Height, Seed],
  ([index, height, seed]) => {
    const prd = prdAt(index);
    const panes = panesOf(height);
    const links = linksOf(prd, cardsOf(demoTrace, prd));
    const boxes = measured(keysOf(links), seed, panes, false);
    Array.forEach(
      Array.filter(wiresOf(links, boxes, panes), (wire) => String.startsWith("prd:")(wire.source)),
      (wire) => {
        const [sx, sy] = numbersOf(wire.path);
        const box = Option.getOrThrow(Record.get(boxes, wire.source));
        expect([sx, sy]).toEqual([panes.prd.x + panes.prd.width, box.y + box.height / 2]);
      },
    );
  },
);

it.prop(
  "a link with an end not measured gives no wire, and every other link gives one",
  [Index, Height, Seed],
  ([index, height, seed]) => {
    const prd = prdAt(index);
    const panes = panesOf(height);
    const links = linksOf(prd, cardsOf(demoTrace, prd));
    const boxes = measured(keysOf(links), seed, panes, true);
    const wires = wiresOf(links, boxes, panes);
    expect(Array.map(wires, (wire) => [wire.source, wire.target])).toEqual(
      pipe(
        links,
        Array.filter((link) => Record.has(boxes, link.source) && Record.has(boxes, link.target)),
        Array.map((link) => [link.source, link.target]),
      ),
    );
  },
);

it.prop(
  "a wire is off the pane exactly when its spec, row or chip end was moved",
  [Index, Height, Seed],
  ([index, height, seed]) => {
    const prd = prdAt(index);
    const panes = panesOf(height);
    const links = linksOf(prd, cardsOf(demoTrace, prd));
    const boxes = measured(keysOf(links), seed, panes, false);
    const isHidden = (key: string): boolean => {
      const box = Option.getOrThrow(Record.get(boxes, key));
      const middle = box.y + box.height / 2;
      const pane = paneOf(key, panes);
      return middle < pane.y + 8 || middle > pane.y + pane.height - 8;
    };
    Array.forEach(wiresOf(links, boxes, panes), (wire) => {
      expect(wire.isOffPane).toBe(
        (!String.startsWith("prd:")(wire.source) && isHidden(wire.source)) || isHidden(wire.target),
      );
    });
  },
);

it("a wire off the pane exists in the data and so does one on it", () => {
  const all = Array.flatMap(prdIds, (prd) => {
    const links = linksOf(prd, cardsOf(demoTrace, prd));
    return Array.flatMap([100, 300, 700], (seed) => {
      const panes = panesOf(300);
      return wiresOf(links, measured(keysOf(links), seed, panes, false), panes);
    });
  });
  expect(Array.some(all, (wire) => wire.isOffPane)).toBe(true);
  expect(Array.some(all, (wire) => !wire.isOffPane)).toBe(true);
});

const folded = stackBoxesOf(demoTrace.tasks, {});
const unfoldedBoxes = stackBoxesOf(
  demoTrace.tasks,
  Record.fromIterableWith(folded, (box) => [box.stack.root, true]),
);

const targets = (links: ReadonlyArray<{ readonly target: string }>) =>
  Array.map(links, (link) => link.target);

it.prop(
  "linksOf ends a task's curve on the key the box gives it: the segment while its trunk is folded",
  [Index],
  ([index]) => {
    const prd = prdAt(index);
    const cards = cardsOf(demoTrace, prd);
    const rowTargets = Array.map(
      Array.filter(linksOf(prd, cards, endKeyInOf(folded)), (link) =>
        String.startsWith("row:")(link.source),
      ),
      (link) => link.target,
    );
    expect(rowTargets).toEqual(
      Array.map(
        Array.filter(linksOf(prd, cards), (link) => String.startsWith("row:")(link.source)),
        (link) =>
          endKeyInOf(folded)(TaskId.make(Array.lastNonEmpty(String.split(link.target, ":")))),
      ),
    );
    // Unfolded, every key is the chip's, as it is with no key function.
    expect(targets(linksOf(prd, cards, endKeyInOf(unfoldedBoxes)))).toEqual(
      targets(linksOf(prd, cards)),
    );
    // Only the ends of row curves move; the PRD and spec ends are the same.
    expect(
      Array.filter(
        linksOf(prd, cards, endKeyInOf(folded)),
        (link) => !String.startsWith("row:")(link.source),
      ),
    ).toEqual(Array.filter(linksOf(prd, cards), (link) => !String.startsWith("row:")(link.source)));
  },
);

it("a section of the demo trace has a task in a folded trunk, so its curve ends on a segment", () => {
  expect(
    Array.some(prdIds, (prd) =>
      Array.some(
        linksOf(prd, cardsOf(demoTrace, prd), endKeyInOf(folded)),
        (link) => link.target === segmentKey("t45"),
      ),
    ),
  ).toBe(true);
});

it.prop(
  "a curve to a segment is a curve to a chip: same path, held inside the stacks pane",
  [Height, Seed],
  ([height, seed]) => {
    const panes = {
      ...panesOf(height),
      // A stacks pane shorter than the spec pane and lower, so a segment held in the wrong pane moves.
      stacks: { height: Math.floor(height / 2), width: 300, x: 900, y: 120 },
    };
    const source = rowKey("spec.viewer.stacks", "t47");
    // Both targets are the one rectangle, in the stacks pane, some of them out of its view.
    const rect = boxOf(taskKey("t45"), seed, panes);
    const wireTo = (target: string): Wire =>
      Option.getOrThrow(
        Array.head(
          wiresOf(
            [{ source, target }],
            { [source]: boxOf(source, seed, panes), [target]: rect },
            panes,
          ),
        ),
      );
    const chip = wireTo(taskKey("t45"));
    const segment = wireTo(segmentKey("t45"));
    expect(segment.path).toBe(chip.path);
    expect(segment.isOffPane).toBe(chip.isOffPane);
  },
);

it("a curve lights for a task in a folded trunk when its trunk is passed, and not otherwise", () => {
  const trunks = Array.flatMap(folded, (box) => Option.toArray(box.maybeTrunk));
  const wire: Wire = {
    isOffPane: false,
    path: "",
    source: rowKey("spec.viewer.stacks", "t47"),
    target: segmentKey("t45"),
  };
  const inTrunk = chainOf(demoTrace, { id: TaskId.make("t47"), kind: "task" });
  const elsewhere = chainOf(demoTrace, { id: TaskId.make("t9"), kind: "task" });
  expect(isWireLit(inTrunk, wire, trunks)).toBe(true);
  // The segment is not a task of the chain unless its trunk is known.
  expect(isWireLit(inTrunk, wire)).toBe(false);
  expect(isWireLit(elsewhere, wire, trunks)).toBe(false);
});
