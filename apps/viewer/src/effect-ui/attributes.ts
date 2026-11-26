import { Array, Option, Record, String, pipe } from "effect";

/**
 * Any element builder, for a function that adds attributes to the builder it is given and returns
 * it: what a Foldkit attribute bundle (`ReadonlyArray<Attribute>`) becomes. Write the parameter
 * `builder: B & Attributable<B>` and return `builder.attrs({ ... })`: builders return `this` from
 * `attrs`, so `withX(h.li.class("row"), ...)` keeps the `h.li` type, and the intersection lets a bare
 * `h.div` in. `undefined` leaves an attribute off.
 */
export interface Attributable<B> {
  readonly attrs: (attributes: Readonly<Record<string, string | undefined>>) => B;
}

/**
 * An inline `style` as Foldkit wrote it: `name: value` declarations joined by `; `, with the
 * property names as given (kebab case and `--custom` properties) and empty values left out. A
 * moved view sets it with `.attr("style", styleText({ ... }))`, not Effect UI's `.style`, which
 * writes `name:value;name:value`: the Scene tests read the declarations in Foldkit's form, and the
 * DOM a view draws does not change while the views move (`spec.viewer.effect-ui.views`).
 * `undefined` when nothing is left, which removes the attribute.
 */
export const styleText = (
  declarations: Record.ReadonlyRecord<string, string>,
): string | undefined =>
  pipe(
    Record.toEntries(declarations),
    Array.filter(([, value]) => String.isNonEmpty(value)),
    Array.map(([name, value]) => `${name}: ${value}`),
    Option.liftPredicate(Array.isReadonlyArrayNonEmpty),
    Option.map(Array.join("; ")),
    Option.getOrUndefined,
  );
