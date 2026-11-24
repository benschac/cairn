import type { PrdSectionId } from "@cairn/contract";
import { Array, Match, Number, Option, Record, String } from "effect";

import type { Rect } from "./geometry.ts";
import type { Cards } from "./reader.ts";

/** What the reader's curves join, as `data-wire` keys: a source key and a target key. */
export interface Link {
  readonly source: string;
  readonly target: string;
}

/** The three panes, each the rectangle it clips to, in window coordinates. */
export interface Panes {
  readonly prd: Rect;
  readonly spec: Rect;
  readonly stacks: Rect;
}

/** A curve to draw: its two keys, its SVG path and whether an end had to be moved into its pane. */
export interface Wire {
  readonly source: string;
  readonly target: string;
  readonly path: string;
  readonly isOffPane: boolean;
}

/** How far in from a pane's top and bottom an end is held, in pixels. */
const INSET = 8;
/** The least a control point sits in from its end, in pixels. */
const MIN_REACH = 20;
/** The spec part of a row's key in the card of strays, which has no spec section. */
const STRAYS = "_";

export const prdKey = (id: PrdSectionId): string => `prd:${id}`;
export const specKey = (id: string): string => `spec:${id}`;
export const rowKey = (spec: string, task: string): string => `row:${spec}:${task}`;
export const taskKey = (id: string): string => `task:${id}`;
/** The `spec` part of a row key for a stray. */
export const strayKey = STRAYS;

/**
 * The curves the current section calls for: its PRD heading to the header of each card, and each
 * task row, a stray's too, to that task's chip in the stacks pane. Spec gap: the spec writes
 * `linksOf(cards)`, but `Cards` does not name the PRD section, so it is the first argument.
 */
export const linksOf = (prd: PrdSectionId, { cards, strays }: Cards): ReadonlyArray<Link> =>
  Array.flatten([
    Array.map(cards, (card) => ({ source: prdKey(prd), target: specKey(card.section.id) })),
    Array.flatMap(cards, (card) =>
      Array.map(card.tasks, (task) => ({
        source: rowKey(card.section.id, task.id),
        target: taskKey(task.id),
      })),
    ),
    Array.map(strays, (task) => ({ source: rowKey(STRAYS, task.id), target: taskKey(task.id) })),
  ]);

interface End {
  readonly x: number;
  readonly y: number;
  readonly isMoved: boolean;
}

const isPrdKey = String.startsWith("prd:");

const paneOf = (key: string, panes: Panes): Rect =>
  Match.value(key).pipe(
    Match.when(isPrdKey, () => panes.prd),
    Match.when(String.startsWith("task:"), () => panes.stacks),
    Match.orElse(() => panes.spec),
  );

/**
 * Where a curve touches a box: the middle of its right edge for a source and of its left edge for
 * a target, its height held inside the key's pane. The PRD end instead leaves the PRD pane's right
 * edge level with the heading, and is never moved.
 */
const endOf = (key: string, box: Rect, panes: Panes, side: "source" | "target"): End => {
  const pane = paneOf(key, panes);
  const middle = box.y + box.height / 2;
  if (isPrdKey(key)) {
    return { isMoved: false, x: pane.x + pane.width, y: middle };
  }
  const y = Number.clamp({ maximum: pane.y + pane.height - INSET, minimum: pane.y + INSET })(
    middle,
  );
  return { isMoved: y !== middle, x: side === "source" ? box.x + box.width : box.x, y };
};

const pathOf = (from: End, to: End): string => {
  const reach = Number.max(MIN_REACH, Math.abs(to.x - from.x) / 2);
  return `M${from.x},${from.y} C${from.x + reach},${from.y} ${to.x - reach},${to.y} ${to.x},${to.y}`;
};

/**
 * A wire for each link whose two ends are both measured, in link order. `boxes` holds each key's
 * rectangle in window coordinates.
 */
export const wiresOf = (
  links: ReadonlyArray<Link>,
  boxes: Record.ReadonlyRecord<string, Rect>,
  panes: Panes,
): ReadonlyArray<Wire> =>
  Array.getSomes(
    Array.map(links, ({ source, target }) =>
      Option.map(
        Option.all([Record.get(boxes, source), Record.get(boxes, target)]),
        ([sourceBox, targetBox]) => {
          const from = endOf(source, sourceBox, panes, "source");
          const to = endOf(target, targetBox, panes, "target");
          return {
            isOffPane: from.isMoved || to.isMoved,
            path: pathOf(from, to),
            source,
            target,
          };
        },
      ),
    ),
  );
