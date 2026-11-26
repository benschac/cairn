import { Data, Effect, Option } from "effect";

// The DOM Commands the viewer runs. Each looks its element up by a selector, as the IDs and data
// attributes the views write name them; Effect UI's own (`HtmlCommand.focus`, ...) take a ref, which
// the views do not give their targets yet (`spec.viewer.effect-ui.components`). A Command starts
// once the render its update caused is committed; these wait one animation frame more, and the
// after-paint scroll two, so an element that render brought into the page has been laid out.

/** No element matched a selector. */
export class ElementNotFound extends Data.TaggedError("ElementNotFound")<{
  readonly selector: string;
}> {}

/** Resumes on the next animation frame. */
const nextAnimationFrame: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const frame = requestAnimationFrame(() => resume(Effect.void));
  return Effect.sync(() => cancelAnimationFrame(frame));
});

/** The page's element that `selector` matches first, if it is an HTML element. */
const elementOf = (selector: string): Effect.Effect<HTMLElement, ElementNotFound> =>
  Effect.suspend(() =>
    Effect.fromOption(
      Option.filter(
        Option.fromNullOr(document.querySelector(selector)),
        (element): element is HTMLElement => element instanceof HTMLElement,
      ),
    ).pipe(Effect.mapError(() => new ElementNotFound({ selector }))),
  );

/** Focuses the element `selector` matches. */
export const focusElement = (selector: string): Effect.Effect<void, ElementNotFound> =>
  nextAnimationFrame.pipe(
    Effect.andThen(elementOf(selector)),
    Effect.map((element) => element.focus({ preventScroll: false })),
  );

/** Scrolls the element `selector` matches into view, to `block` in the box that scrolls. */
export const scrollElementIntoView = (
  selector: string,
  block: ScrollLogicalPosition = "nearest",
): Effect.Effect<void, ElementNotFound> =>
  nextAnimationFrame.pipe(
    Effect.andThen(elementOf(selector)),
    Effect.map((element) => element.scrollIntoView({ block })),
  );

/**
 * Scrolls the element `selector` matches into view once the render has been painted: for a target
 * the same Message brought into the page.
 */
export const scrollElementIntoViewAfterPaint = (
  selector: string,
  block: ScrollLogicalPosition = "nearest",
): Effect.Effect<void, ElementNotFound> =>
  nextAnimationFrame.pipe(Effect.andThen(scrollElementIntoView(selector, block)));
