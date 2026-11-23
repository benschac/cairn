import type { Trace } from "@cairn/contract";
import { Array, Option, Record, Schema } from "effect";

import { resultOf, type SearchResult } from "./search.ts";
import { Node, chainOf, isInChain, type Chain } from "./trace.ts";

/** The colours a pinned chain takes, in the order new pins take them. */
export const PinColor = Schema.Literals(["blue", "rose", "green", "violet", "orange", "cyan"]);
export type PinColor = typeof PinColor.Type;

/** A pin's colour: a pale fill for its nodes and a strong stroke for its curves. */
export const PIN_PALETTE = {
  blue: { fill: "#dbeafe", stroke: "#2563eb" },
  cyan: { fill: "#cffafe", stroke: "#0891b2" },
  green: { fill: "#dcfce7", stroke: "#16a34a" },
  orange: { fill: "#ffedd5", stroke: "#ea580c" },
  rose: { fill: "#ffe4e6", stroke: "#e11d48" },
  violet: { fill: "#ede9fe", stroke: "#7c3aed" },
} satisfies Record.ReadonlyRecord<PinColor, Readonly<{ fill: string; stroke: string }>>;

/** The fill of the hovered node's chain, which is a preview and has no pin colour. */
export const HOVER_FILL = "#fef08a";

/** The fill of the active search result's chain, which is a preview too and has no pin colour. */
export const SEARCH_FILL = "#e7e5e4";

/** A node whose chain stays lit in its colour until the node is clicked again or the pins are cleared. */
export const Pin = Schema.Struct({ color: PinColor, node: Node });
export type Pin = typeof Pin.Type;

const nodeEquivalence = Schema.toEquivalence(Node);

export const isPinned = (pins: ReadonlyArray<Pin>, node: Node): boolean =>
  Array.some(pins, (pin) => nodeEquivalence(pin.node, node));

/** The first colour no pin holds; once every colour is taken they repeat, in order. */
export const nextPinColor = (pins: ReadonlyArray<Pin>): PinColor =>
  Option.getOrElse(
    Option.orElse(
      Array.findFirst(
        PinColor.literals,
        (color) => !Array.some(pins, (pin) => pin.color === color),
      ),
      () => Array.get(PinColor.literals, pins.length % PinColor.literals.length),
    ),
    () => "blue",
  );

/** Pins the node in the next free colour, or unpins it when it is pinned. */
export const togglePin = (pins: ReadonlyArray<Pin>, node: Node): ReadonlyArray<Pin> =>
  isPinned(pins, node)
    ? Array.filter(pins, (pin) => !nodeEquivalence(pin.node, node))
    : Array.append(pins, { color: nextPinColor(pins), node });

/** Pins the node unless it is pinned already. */
export const pin = (pins: ReadonlyArray<Pin>, node: Node): ReadonlyArray<Pin> =>
  isPinned(pins, node) ? pins : togglePin(pins, node);

/** What lit a chain: a pin, the active search result, or the hovered node. */
export type ChainSource = "hover" | "pin" | "search";

/** A chain lit on the canvas: a pin's, in its colour, or a preview's, which has none. */
export interface LitChain {
  readonly chain: Chain;
  readonly maybeColor: Option.Option<PinColor>;
  readonly source: ChainSource;
}

const previewOf = (trace: Trace, source: ChainSource, node: Node): LitChain => ({
  chain: chainOf(trace, node),
  maybeColor: Option.none<PinColor>(),
  source,
});

/**
 * The pinned chains in the order they were pinned, then the active search result's, then the
 * hovered node's on top: a preview adds to the pins and never hides one, and only the one active
 * result has a chain, so results' chains are never joined. Empty while nothing is pinned,
 * searched or hovered.
 */
export const litChainsOf = (
  trace: Trace,
  pins: ReadonlyArray<Pin>,
  maybeSearched: Option.Option<Node>,
  maybeHovered: Option.Option<Node>,
): ReadonlyArray<LitChain> =>
  Array.appendAll(
    Array.map(pins, (each) => ({
      chain: chainOf(trace, each.node),
      maybeColor: Option.some(each.color),
      source: "pin" as const,
    })),
    Array.getSomes([
      Option.map(maybeSearched, (node) => previewOf(trace, "search", node)),
      Option.map(maybeHovered, (node) => previewOf(trace, "hover", node)),
    ]),
  );

/** How the search touches one node: the result it matched directly, and whether that is the active one. */
export interface NodeSearch {
  readonly isActive: boolean;
  readonly maybeMatch: Option.Option<SearchResult>;
}

export const nodeSearchOf = (
  results: ReadonlyArray<SearchResult>,
  maybeActive: Option.Option<Node>,
  node: Node,
): NodeSearch => ({
  isActive: Option.exists(maybeActive, (active) => nodeEquivalence(active, node)),
  maybeMatch: resultOf(results, node),
});

/** The lit chains a node is in, bottom to top. */
export const chainsHolding = (lit: ReadonlyArray<LitChain>, node: Node): ReadonlyArray<LitChain> =>
  Array.filter(lit, ({ chain }) => isInChain(chain, node));

/** The pin colours among some lit chains, bottom to top. */
export const pinColorsOf = (lit: ReadonlyArray<LitChain>): ReadonlyArray<PinColor> =>
  Array.getSomes(Array.map(lit, ({ maybeColor }) => maybeColor));
