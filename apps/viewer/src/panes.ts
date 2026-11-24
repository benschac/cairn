import { Match, Number, Option, Schema, Struct } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

/** The panes with a divider: the PRD, the spec and the detail panel. The stacks pane takes what is left. */
export const Pane = Schema.Literals(["prd", "spec", "detail"]);
export type Pane = typeof Pane.Type;

/** What a person chose for each pane, in pixels. Not what the window has room for. */
export const Widths = Schema.Struct({
  detail: Schema.Finite,
  prd: Schema.Finite,
  spec: Schema.Finite,
});
export type Widths = typeof Widths.Type;

export const INITIAL_WIDTHS: Widths = { detail: 600, prd: 520, spec: 440 };

/** A pane's least and greatest width. */
export interface Limits {
  readonly max: number;
  readonly min: number;
}

export const limitsOf = (pane: Pane): Limits =>
  Match.value(pane).pipe(
    Match.withReturnType<Limits>(),
    Match.when("prd", () => ({ max: 1000, min: 300 })),
    Match.when("spec", () => ({ max: 1100, min: 260 })),
    Match.when("detail", () => ({ max: 1400, min: 360 })),
    Match.exhaustive,
  );

/** The widths with one pane set to `width`. */
export const withWidth = (widths: Widths, pane: Pane, width: number): Widths =>
  Match.value(pane).pipe(
    Match.withReturnType<Widths>(),
    Match.when("prd", () => Struct.assign(widths, { prd: width })),
    Match.when("spec", () => Struct.assign(widths, { spec: width })),
    Match.when("detail", () => Struct.assign(widths, { detail: width })),
    Match.exhaustive,
  );

/** The widths with `delta` added to one pane, held between that pane's limits. */
export const resized = (widths: Widths, pane: Pane, delta: number): Widths => {
  const { max, min } = limitsOf(pane);
  return withWidth(
    widths,
    pane,
    Number.clamp(widths[pane] + delta, { maximum: max, minimum: min }),
  );
};

/**
 * A divider moved right by `dx` pixels changes its pane by `dx`, except the detail panel's, which
 * sits on the panel's left edge: moving that right makes the panel narrower.
 */
export const deltaOf = (pane: Pane, dx: number): number =>
  Match.value(pane).pipe(
    Match.when("detail", () => -dx),
    Match.orElse(() => dx),
  );

/** Pixels one arrow key press moves a divider. */
export const ARROW_STEP = 24;

/** The arrow keys that move a divider. */
export const DividerKey = Schema.Literals(["ArrowLeft", "ArrowRight"]);
export type DividerKey = typeof DividerKey.Type;

export const dividerKeyOf = (key: string): Option.Option<DividerKey> =>
  Option.liftPredicate(key, Schema.is(DividerKey));

/** How far the divider moves for a key: left is negative. */
export const stepOf = (key: DividerKey): number => (key === "ArrowLeft" ? -ARROW_STEP : ARROW_STEP);

/**
 * No resize, or one pane being resized by one pointer: where the pointer was at the press and the
 * pane's width then. Moves and releases from any other pointer are ignored.
 */
export const Resize = defineTaggedUnion({
  Idle: {},
  Resizing: { pane: Pane, pointerId: Schema.Int, startWidth: Schema.Finite, startX: Schema.Finite },
});
export type Resize = typeof Resize.Type;

/** The pointer of a resize in progress; none while idle. */
export const resizePointerOf = (resize: Resize): Option.Option<number> =>
  Resize.match(resize, {
    Idle: () => Option.none(),
    Resizing: ({ pointerId }) => Option.some(pointerId),
  });

/**
 * The widths with the resized pane at its width at the press plus the pointer's travel since, held
 * between its limits.
 */
export const draggedTo = (
  widths: Widths,
  resizing: Extract<Resize, { readonly _tag: "Resizing" }>,
  x: number,
): Widths =>
  resized(
    withWidth(widths, resizing.pane, resizing.startWidth),
    resizing.pane,
    deltaOf(resizing.pane, x - resizing.startX),
  );
