import { View } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Array, Function, Record } from "effect";

/**
 * SVG for an Effect UI view. `@effect/ui/html` has no SVG builders, but its host and its server
 * serializer already create an element in the SVG namespace when its tag is one they list
 * (`svgTags` in `html/internal/elements.ts`), and they normalise its attribute names, so
 * `viewBox` keeps its case. So an SVG builder is the HTML element builder under an SVG tag, and
 * it reads as `h` does: `svg.path.attr("d", d).class("edge").on("click", message)`, with
 * `key`, `style`, `ref`, `onMount` and `children` as on any element.
 *
 * `title` is not here: the host lists no `title` among the SVG tags, so it would be an HTML
 * element. Name a shape with `aria-label`.
 */

/** The SVG tags the viewer draws, and the ones a diagram next to them is likely to. */
export const svgTagNames = [
  "svg",
  "g",
  "path",
  "line",
  "rect",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "text",
  "tspan",
  "defs",
  "marker",
  "use",
  "symbol",
  "clipPath",
  "linearGradient",
  "stop",
] as const;

export type SvgTag = (typeof svgTagNames)[number];

/** An SVG element builder: the HTML one, callable as shorthand for `children`, typed by its tag. */
export type SvgBuilder<Msg, K extends SvgTag> = View.Shorthand<
  Html.Element<Msg, never, Html.EventsOf<K>, SVGElement, K>
>;

/** The builders, one per tag, as `h` has them. */
export type Svg<Msg> = { readonly [K in SvgTag]: SvgBuilder<Msg, K> };

const builders = Record.fromEntries(
  Array.map(svgTagNames, (tag) => [tag, View.shorthand(new Html.Element(tag))] as const),
);

/**
 * The builders, made once and shared by every render, as Effect UI's own `tags` are. A builder
 * holds no Message, so `svgFor<Message>()` only names the one a view's handlers send.
 */
export const svgFor = <Msg>(): Svg<Msg> => Function.cast(builders);
