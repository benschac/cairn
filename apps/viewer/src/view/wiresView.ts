import type { PrdSectionId, Trace } from "@cairn/contract";
import {
  Array,
  Cause,
  Effect,
  MutableRef,
  Option,
  Predicate,
  Queue,
  Record,
  Schema,
  Stream,
} from "effect";
import { Mount } from "foldkit";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { rectOf, type Rect } from "../geometry.ts";
import { Message } from "../message.ts";
import { cardsOf } from "../reader.ts";
import type { Chain, Node } from "../trace.ts";
import { Measured, hoverChainOf, isWireLit, linksOf, wiresOf, type Wire } from "../wires.ts";

/** The attribute on the reader's body that holds what changes the layout without changing a size. */
export const WIRES_ATTRIBUTE = "data-wires";

const PRD_PANE = "[data-prd-pane]";
const SPEC_PANE = "[data-spec-pane]";
const STACKS_PANE = "[data-stacks-pane]";

const rectOfElement = (element: Element): Rect => rectOf(element.getBoundingClientRect());

/** Every `[data-wire]` element's rectangle, by its key. */
const boxesOf = (body: Element): Measured["boxes"] =>
  Record.fromEntries(
    Array.getSomes(
      Array.map(Array.fromIterable(body.querySelectorAll("[data-wire]")), (element) =>
        Option.map(
          Option.fromNullOr(element.getAttribute("data-wire")),
          (key) => [key, rectOfElement(element)] as const,
        ),
      ),
    ),
  );

/** What the body holds, in window coordinates; none until all three panes are in the page. */
export const measureBody = (body: Element): Option.Option<Measured> =>
  Option.map(
    Option.all({
      prd: Option.fromNullOr(body.querySelector(PRD_PANE)),
      spec: Option.fromNullOr(body.querySelector(SPEC_PANE)),
      stacks: Option.fromNullOr(body.querySelector(STACKS_PANE)),
    }),
    ({ prd, spec, stacks }) => ({
      boxes: boxesOf(body),
      panes: { prd: rectOfElement(prd), spec: rectOfElement(spec), stacks: rectOfElement(stacks) },
    }),
  );

const sameMeasured = Schema.toEquivalence(Measured);

type WiresMessage = typeof Message.MeasuredWires.Type;

/** A pane and the content inside it, which is what grows when a card opens. */
const watchedIn = (body: Element): ReadonlyArray<Element> =>
  Array.flatMap(
    Array.getSomes(
      Array.map([PRD_PANE, SPEC_PANE, STACKS_PANE], (selector) =>
        Option.fromNullOr(body.querySelector(selector)),
      ),
    ),
    (pane) => Array.prepend(Array.fromOption(Option.fromNullOr(pane.firstElementChild)), pane),
  );

/**
 * Reads the body once it mounts and then whenever it may have changed. Anything that may move a
 * rectangle asks for a look, and the look happens at most once per animation frame; the answer is
 * sent only when it differs from the last one sent. The listeners, the observers and a pending
 * frame are released when the body goes.
 */
const measureWires = (body: Element, queue: Queue.Queue<WiresMessage, Cause.Done>) =>
  Effect.gen(function* () {
    const sent = MutableRef.make(Option.none<Measured>());
    const frame = MutableRef.make(Option.none<number>());
    const report = () =>
      Option.match(
        Option.filter(
          measureBody(body),
          (measured) =>
            !Option.exists(MutableRef.get(sent), (last) => sameMeasured(last, measured)),
        ),
        {
          onNone: () => undefined,
          onSome: (measured) => {
            MutableRef.set(sent, Option.some(measured));
            Queue.offerUnsafe(queue, Message.MeasuredWires({ measured }));
          },
        },
      );
    const schedule = () =>
      Option.match(MutableRef.get(frame), {
        onNone: () =>
          MutableRef.set(
            frame,
            Option.some(
              requestAnimationFrame(() => {
                MutableRef.set(frame, Option.none());
                report();
              }),
            ),
          ),
        onSome: () => undefined,
      });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => Option.map(MutableRef.get(frame), cancelAnimationFrame)),
    );
    // A scroll does not bubble, so the body hears every pane's in the capture phase.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        body.addEventListener("scroll", schedule, true);
        window.addEventListener("resize", schedule);
      }),
      () =>
        Effect.sync(() => {
          body.removeEventListener("scroll", schedule, true);
          window.removeEventListener("resize", schedule);
        }),
    );
    // Environments without ResizeObserver (jsdom) look at the scroll and the attribute alone.
    const maybeResize = Predicate.hasProperty(globalThis, "ResizeObserver")
      ? Option.some(new ResizeObserver(schedule))
      : Option.none<ResizeObserver>();
    const watch = () =>
      Option.map(maybeResize, (observer) =>
        Array.forEach(watchedIn(body), (element) => observer.observe(element)),
      );
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        // The current section changes what a pane holds, so what is watched is looked up again.
        const observer = new MutationObserver(() => {
          watch();
          schedule();
        });
        observer.observe(body, { attributeFilter: [WIRES_ATTRIBUTE], attributes: true });
        watch();
        return observer;
      }),
      (observer) =>
        Effect.sync(() => {
          observer.disconnect();
          Option.map(maybeResize, (resize) => resize.disconnect());
        }),
    );
    yield* Effect.sync(schedule);
  });

/**
 * Reads the rectangle of every `[data-wire]` element and of the three panes, and sends
 * `MeasuredWires` once it mounts and then each time they change. It runs on the reader's body.
 */
export const MeasureWires = Mount.defineStream("MeasureWires", {
  execute: ({ element }) => Stream.callback<WiresMessage>((queue) => measureWires(element, queue)),
  messages: [Message.MeasuredWires],
});

/**
 * What a node that can be hovered sends: it is hovered on pointer enter and on focus, and left on
 * pointer leave and on blur, so a keyboard reader sees the same chain a mouse does.
 */
export const hoverAttributesOf = (
  node: Node,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Attribute<Message>> => [
  h.OnMouseEnter(Message.HoveredNode({ node })),
  h.OnMouseLeave(Message.LeftNode()),
  h.OnFocus(Message.HoveredNode({ node })),
  h.OnBlur(Message.LeftNode()),
];

/** How faint a wire is while it is not lit, and how faint one with an end moved is. */
const DIMMED_OPACITY = "0.15";
const OFF_PANE_OPACITY = "0.45";

const wireView = (wire: Wire, maybeChain: Option.Option<Chain>, h: HtmlBuilder<Message>): Html => {
  const isLit = Option.exists(maybeChain, (chain) => isWireLit(chain, wire));
  const isDimmed = Option.isSome(maybeChain) && !isLit;
  return h.path(
    Array.flatten([
      [
        h.DataAttribute("wire-source", wire.source),
        h.DataAttribute("wire-target", wire.target),
        h.DataAttribute("off-pane", `${wire.isOffPane}`),
        h.D(wire.path),
        h.Fill("none"),
        h.Style({
          opacity: isDimmed ? DIMMED_OPACITY : wire.isOffPane ? OFF_PANE_OPACITY : "1",
          stroke: isLit ? "var(--ink)" : "var(--muted)",
          "stroke-dasharray": wire.isOffPane ? "5 4" : "none",
          "stroke-width": isLit ? "2.5" : "1.5",
          transition:
            "opacity var(--d-fade) ease-out, stroke var(--d-fade) ease-out, stroke-width var(--d-fade) ease-out",
        }),
      ],
      isLit ? [h.DataAttribute("lit", "")] : [],
      isDimmed ? [h.DataAttribute("dimmed", "")] : [],
    ]),
  );
};

/**
 * One SVG over the reader's body, fixed and out of the pointer's way: a path for each link of the
 * current section whose two ends were measured. While a node is hovered the wires with both ends
 * in its chain are lit and the rest fainter.
 */
export const wiresView = (
  trace: Trace,
  maybeCurrent: Option.Option<PrdSectionId>,
  maybeMeasured: Option.Option<Measured>,
  maybeHovered: Option.Option<Node>,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeChain = hoverChainOf(trace, maybeHovered);
  const wires = Option.match(Option.all({ current: maybeCurrent, measured: maybeMeasured }), {
    onNone: (): ReadonlyArray<Wire> => [],
    onSome: ({ current, measured }) =>
      wiresOf(linksOf(current, cardsOf(trace, current)), measured.boxes, measured.panes),
  });
  return h.svg(
    [
      h.DataAttribute("wire-layer", ""),
      h.AriaHidden(true),
      h.Style({
        height: "100%",
        inset: "0",
        overflow: "visible",
        "pointer-events": "none",
        position: "fixed",
        width: "100%",
      }),
    ],
    Array.map(wires, (wire) => wireView(wire, maybeChain, h)),
  );
};
