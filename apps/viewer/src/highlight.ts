import type { Trace } from "@cairn/contract";
import { Array, Option, Record, Schema } from "effect";

import { resultOf, type Search, type SearchResult } from "./search.ts";
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

/** The fill of the active search result's chain: a preview with no pin colour, unlike the hover's. */
export const SEARCH_FILL = "#e7e5e4";

/** The stroke of a curve in the active search result's chain, when no pin holds it. */
export const SEARCH_STROKE = "#44403c";

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

/** What lights a chain: a pin, the active search result or the hovered node. */
export type LitSource = "hover" | "pin" | "search";

/**
 * A chain lit on the canvas: a pin's, in its colour, or the active search result's or the hovered
 * node's, which have none.
 */
export interface LitChain {
  readonly chain: Chain;
  readonly maybeColor: Option.Option<PinColor>;
  readonly source: LitSource;
}

/**
 * The pinned chains in the order they were pinned, then the active search result's, then the
 * hovered node's on top: searching and hovering add previews and never hide a pin, and hovering
 * stays above a search. Each chain is its own; they are never merged. Empty while nothing is
 * pinned, searched or hovered.
 */
export const litChainsOf = (
  trace: Trace,
  pins: ReadonlyArray<Pin>,
  maybeSearched: Option.Option<Node>,
  maybeHovered: Option.Option<Node>,
): ReadonlyArray<LitChain> => {
  const preview = (source: LitSource, maybeNode: Option.Option<Node>): ReadonlyArray<LitChain> =>
    Array.fromOption(
      Option.map(maybeNode, (node) => ({
        chain: chainOf(trace, node),
        maybeColor: Option.none<PinColor>(),
        source,
      })),
    );
  return Array.flatten([
    Array.map(pins, (each): LitChain => ({
      chain: chainOf(trace, each.node),
      maybeColor: Option.some(each.color),
      source: "pin",
    })),
    preview("search", maybeSearched),
    preview("hover", maybeHovered),
  ]);
};

/** How a node stands in the search: the active result, another direct match, or neither. */
export type SearchRole = "active" | "match" | "none";

/** The search result that matched the node directly, if any. */
export const searchMatchOf = (search: Search, node: Node): Option.Option<SearchResult> =>
  resultOf(search.results, node);

export const searchRoleOf = (search: Search, node: Node): SearchRole =>
  Option.match(searchMatchOf(search, node), {
    onNone: () => "none",
    onSome: () =>
      Option.exists(search.maybeActive, (active) => nodeEquivalence(active, node))
        ? "active"
        : "match",
  });

/** The lit chains a node is in, bottom to top. */
export const chainsHolding = (lit: ReadonlyArray<LitChain>, node: Node): ReadonlyArray<LitChain> =>
  Array.filter(lit, ({ chain }) => isInChain(chain, node));

/** The pin colours among some lit chains, bottom to top. */
export const pinColorsOf = (lit: ReadonlyArray<LitChain>): ReadonlyArray<PinColor> =>
  Array.getSomes(Array.map(lit, ({ maybeColor }) => maybeColor));
