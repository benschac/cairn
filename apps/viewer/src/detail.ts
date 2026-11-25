import { Array, Option, Schema } from "effect";

import { Node } from "./trace.ts";

/**
 * The detail panel's trail (see spec.viewer.detail-panel): the nodes opened in it, first to last.
 * An empty trail is a closed panel, and the last node is the one shown.
 */
export type Trail = ReadonlyArray<Node>;

/** The id of the open panel's heading, which names the panel and takes focus when its node changes. */
export const DETAIL_HEADING_ID = "detail-heading";

/** A closed panel. */
export const CLOSED: Trail = [];

/** A new trail on one node: what a task row or a chip opens, whatever was open before. */
export const openedOn = (node: Node): Trail => [node];

/** The trail with a node opened from inside the panel added at its end. */
export const extendedBy = (trail: Trail, node: Node): Trail => Array.append(trail, node);

/** The trail cut back to the step at `index`, which stays; a step the trail does not have changes nothing. */
export const cutBackTo = (trail: Trail, index: number): Trail =>
  Option.match(Array.get(trail, index), {
    onNone: () => trail,
    onSome: () => Array.take(trail, index + 1),
  });

const nodeEquivalence = Schema.toEquivalence(Node);

/**
 * The trail ending on a node: added at its end unless the trail already ends on it. A commit a link
 * opens puts its task there this way, so the trail's last task is the code view's.
 */
export const endingOn = (trail: Trail, node: Node): Trail =>
  Option.exists(nodeShownBy(trail), (last) => nodeEquivalence(last, node))
    ? trail
    : extendedBy(trail, node);

/** The trail one step back; the first step goes back to a closed panel. */
export const wentBack = (trail: Trail): Trail => Array.dropRight(trail, 1);

/** The node shown, when the panel is open. */
export const nodeShownBy = (trail: Trail): Option.Option<Node> => Array.last(trail);
