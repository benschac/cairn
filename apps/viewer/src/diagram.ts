import { Array, Effect, Hash, Number, Option, Predicate, Schema, Stream, String } from "effect";
import { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { renderAsync } from "pele/lazy";

import { CODE_BLOCK_CLASS } from "./code.ts";
import { measureLayer } from "./layout.ts";
import { Message } from "./message.ts";

/**
 * Pele draws a Mermaid diagram as an SVG string. It escapes the diagram's text, ignores `click`
 * callbacks and filters styles, so the SVG holds shapes and text and nothing that runs. Links and
 * images are switched off as well: a diagram in a PRD must not navigate anywhere or fetch anything.
 * The lazy entry loads each diagram type's code on its first use, so the bundle holds the core
 * only and a PRD with no diagram costs nothing.
 */
const drawn = (source: string, width: number): Promise<string> =>
  renderAsync(source, {
    // One prefix per diagram keeps the ids inside two diagrams on a page apart.
    idPrefix: `diagram-${Hash.string(source) >>> 0}`,
    images: false,
    links: false,
    ...Option.match(Option.liftPredicate(width, Number.isGreaterThan(0)), {
      onNone: () => ({}),
      onSome: (maxWidth) => ({ maxWidth }),
    }),
  }).then(({ svg }) => svg);

/** The first line of an error: Pele's messages go on to quote the source. */
const reasonOf = (error: unknown): string =>
  Predicate.isError(error)
    ? String.trim(Array.headNonEmpty(String.split(error.message, "\n")))
    : "The diagram could not be drawn";

/** The SVG for a diagram in a column `width` pixels wide, or why it could not be drawn. */
export const drawDiagram = (source: string, width: number): Effect.Effect<string, string> =>
  Effect.tryPromise({ catch: reasonOf, try: () => drawn(source, width) });

/** What painting a diagram needs from the element it paints, so the choice can be tested without a DOM. */
export interface DiagramHost {
  /** The width the diagram has to fit. */
  readonly width: number;
  readonly showSvg: (svg: string) => void;
  /** A diagram that cannot be drawn shows its source and the reason. */
  readonly showSource: (source: string, reason: string) => void;
}

/** Draws the diagram on the host, or shows its source and why it failed. */
export const paintDiagram = (host: DiagramHost, source: string): Effect.Effect<void> =>
  Effect.match(drawDiagram(source, host.width), {
    onFailure: (reason) => host.showSource(source, reason),
    onSuccess: host.showSvg,
  });

/**
 * The element's DOM. The SVG is Pele's escaped output; the source and the reason go in as text.
 * This is the one place Mermaid's output becomes DOM, and only a Mount reaches it.
 */
const hostOf = (element: Element): DiagramHost => ({
  showSource: (source, reason) => {
    const { ownerDocument: document } = element;
    const note = document.createElement("p");
    note.setAttribute("role", "alert");
    note.textContent = `The diagram could not be drawn: ${reason}`;
    const code = document.createElement("code");
    code.textContent = source;
    const pre = document.createElement("pre");
    pre.className = CODE_BLOCK_CLASS;
    pre.append(code);
    element.replaceChildren(note, pre);
  },
  showSvg: (svg) => {
    element.innerHTML = svg;
  },
  width: element.clientWidth,
});

/** The canvas layer a diagram sits in. */
const layerOf = (element: Element): Option.Option<Element> =>
  Option.fromNullOr(element.closest("[data-canvas-layer]"));

/**
 * Draws the diagram into the element once it is in the page, which for a diagram type not loaded
 * yet is a moment after it mounts. Unmounting first interrupts the draw. A diagram changes the height of its
 * column, which moves every section below it, and the layer's ResizeObserver only fires when the
 * layer's own size changes, so this measures the layer itself once the diagram is in.
 */
export const DrawDiagram = Mount.defineStream("DrawDiagram", {
  args: { source: Schema.String },
  execute: ({ element, source }) =>
    Stream.fromEffect(
      Effect.as(
        paintDiagram(hostOf(element), source),
        Array.fromOption(
          Option.map(layerOf(element), (layer) =>
            Message.MeasuredLayout({ positions: measureLayer(layer) }),
          ),
        ),
      ),
    ).pipe(Stream.flattenIterable),
  messages: [Message.MeasuredLayout],
});

/**
 * Where a Mermaid block goes. It has no children: the Mount owns what is inside it. A Mount runs
 * once, when its element is inserted, and its args are fixed then, so the element is keyed by the
 * diagram's `key`: a changed diagram gets a new element and is drawn again, instead of the old
 * element keeping the old drawing.
 */
export const diagramView = (h: HtmlBuilder<Message>, source: string, key: string): Html =>
  h.keyed("div")(key, [
    h.DataAttribute("diagram", ""),
    h.OnMount(DrawDiagram({ source })),
    // Pele's colours are light only.
    h.Class("diagram light-only"),
  ]);
