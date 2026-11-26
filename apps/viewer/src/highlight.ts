import { Option, Schema } from "effect";

import { resultOf, type SearchResult } from "./search.ts";
import { Node } from "./trace.ts";

const nodeEquivalence = Schema.toEquivalence(Node);

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
