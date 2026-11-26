import type { PrdSectionId, TaskId, Trace } from "@cairn/contract";
import { Array, HashSet, Match, Number, Option, Predicate, Record, Schema, String } from "effect";

import type { Trunk } from "./boxes.ts";
import { Positions, Rect } from "./geometry.ts";
import type { Cards } from "./reader.ts";
import { chainOf, type Chain, type Node } from "./trace.ts";

/** What the reader's curves join, as `data-wire` keys: a source key and a target key. */
export interface Link {
  readonly source: string;
  readonly target: string;
}

/** The three panes, each the rectangle it clips to, in window coordinates. */
export const Panes = Schema.Struct({ prd: Rect, spec: Rect, stacks: Rect });
export type Panes = typeof Panes.Type;

/** What `MeasureWires` read from the page: the rectangle of each `data-wire` key, and of the panes. */
export const Measured = Schema.Struct({ boxes: Positions, panes: Panes });
export type Measured = typeof Measured.Type;

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
export const segmentKey = (root: string): string => `segment:${root}`;
export const forkKey = (id: string): string => `fork:${id}`;
/** The `spec` part of a row key for a stray. */
export const strayKey = STRAYS;

/**
 * The curves the current section calls for: its PRD heading to the header of each card, and each
 * task row, a stray's too, to the key `endKey` gives its task: its chip in the stacks pane, or the
 * segment of the folded trunk it is in. Spec gap: the spec writes `linksOf(cards)`, but `Cards`
 * does not name the PRD section, so it is the first argument.
 */
export const linksOf = (
  prd: PrdSectionId,
  { cards, strays }: Cards,
  endKey: (id: TaskId) => string = taskKey,
): ReadonlyArray<Link> =>
  Array.flatten([
    Array.map(cards, (card) => ({ source: prdKey(prd), target: specKey(card.section.id) })),
    Array.flatMap(cards, (card) =>
      Array.map(card.tasks, (task) => ({
        source: rowKey(card.section.id, task.id),
        target: endKey(task.id),
      })),
    ),
    Array.map(strays, (task) => ({ source: rowKey(STRAYS, task.id), target: endKey(task.id) })),
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
    Match.when(
      Predicate.some([
        String.startsWith("task:"),
        String.startsWith("segment:"),
        String.startsWith("fork:"),
      ]),
      () => panes.stacks,
    ),
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

/** The chain of the hovered node, when a node is hovered. */
export const hoverChainOf = (
  trace: Trace,
  maybeHovered: Option.Option<Node>,
): Option.Option<Chain> => Option.map(maybeHovered, (node) => chainOf(trace, node));

/** Whether a spec section is outside the hovered chain: its card is dimmed. */
export const isSpecDimmed = (maybeChain: Option.Option<Chain>, id: string): boolean =>
  Option.exists(maybeChain, (chain) => !HashSet.has(chain.spec, id));

/** Whether a task is outside the hovered chain: its row and its chip are dimmed. */
export const isTaskDimmed = (maybeChain: Option.Option<Chain>, id: string): boolean =>
  Option.exists(maybeChain, (chain) => !HashSet.has(chain.tasks, id));

/**
 * Whether the element a key names is in the chain. A row counts as its task, a segment counts as
 * the tasks of its trunk, and a key that names nothing the chain holds is not in it.
 */
export const isKeyInChain = (
  chain: Chain,
  key: string,
  trunks: ReadonlyArray<Pick<Trunk, "root" | "tasks">> = [],
): boolean => {
  const parts = String.split(":")(key);
  const id = Array.lastNonEmpty(parts);
  return Match.value(Array.headNonEmpty(parts)).pipe(
    Match.when("prd", () => HashSet.has(chain.prd, id)),
    Match.when("spec", () => HashSet.has(chain.spec, id)),
    Match.whenOr("row", "task", () => HashSet.has(chain.tasks, id)),
    Match.when("segment", () =>
      Array.some(
        trunks,
        (trunk) =>
          trunk.root === id && Array.some(trunk.tasks, (task) => HashSet.has(chain.tasks, task)),
      ),
    ),
    Match.orElse(() => false),
  );
};

/** Whether the chain holds both ends of the wire: it is lit while its node is hovered. */
export const isWireLit = (
  chain: Chain,
  wire: Wire,
  trunks: ReadonlyArray<Pick<Trunk, "root" | "tasks">> = [],
): boolean => isKeyInChain(chain, wire.source, trunks) && isKeyInChain(chain, wire.target, trunks);
