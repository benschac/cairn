import type { PrdSectionId, Trace } from "@cairn/contract";
import { Mount as UiMount } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import {
  Array,
  Cause,
  Effect,
  Match,
  MutableRef,
  Option,
  Predicate,
  Queue,
  Record,
  Schema,
  Stream,
  String,
} from "effect";

import { styleText } from "../effect-ui/attributes.ts";
import { svgFor } from "../effect-ui/svg.ts";
import { endKeyInOf, stackBoxesOf, type Trunk } from "../boxes.ts";
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

type WiresMessage = typeof Message.cases.MeasuredWires.Type;

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
export const MeasureWires = UiMount.makeStream(
  "MeasureWires",
  { args: {} },
  (element: HTMLElement) => Stream.callback<WiresMessage>((queue) => measureWires(element, queue)),
);

/** An `h.button` builder, with whatever the caller chained on it. */
type ButtonBuilder = Html.Element<
  Message,
  unknown,
  Html.EventsOf<"button">,
  HTMLButtonElement,
  "button"
>;

/**
 * What a node that can be hovered sends, on the button it is given: it is hovered on pointer enter
 * and on focus, and left on pointer leave and on blur, so a keyboard reader sees the same chain a
 * mouse does.
 */
export const withHover = <B extends ButtonBuilder>(builder: B, node: Node): B =>
  builder
    .on("mouseenter", Message.HoveredNode({ node }))
    .on("mouseleave", Message.LeftNode())
    .on("focus", Message.HoveredNode({ node }))
    .on("blur", Message.LeftNode());

/** How faint a wire is while another chain is hovered, when off-pane, and at rest. */
const DIMMED_OPACITY = "0.1";
const OFF_PANE_OPACITY = "0.18";
const LIT_OFF_PANE_OPACITY = "0.28";
const PRD_OPACITY = "0.8";
const ROW_OPACITY = "0.4";

const opacityOf = (wire: Wire, isLit: boolean, isDimmed: boolean): string =>
  Match.value({
    isDimmed,
    isLit,
    isOffPane: wire.isOffPane,
    isPrd: String.startsWith("prd:")(wire.source),
  }).pipe(
    Match.when({ isLit: true, isOffPane: true }, () => LIT_OFF_PANE_OPACITY),
    Match.when({ isLit: true }, () => "1"),
    Match.when({ isDimmed: true }, () => DIMMED_OPACITY),
    Match.when({ isOffPane: true }, () => OFF_PANE_OPACITY),
    Match.when({ isPrd: true }, () => PRD_OPACITY),
    Match.orElse(() => ROW_OPACITY),
  );

const svg = svgFor<Message>();

const wireView = (wire: Wire, maybeChain: Option.Option<Chain>, trunks: ReadonlyArray<Trunk>) => {
  const isLit = Option.exists(maybeChain, (chain) => isWireLit(chain, wire, trunks));
  const isDimmed = Option.isSome(maybeChain) && !isLit;
  return svg.path
    .attr("data-wire-source", wire.source)
    .attr("data-wire-target", wire.target)
    .attr("data-off-pane", `${wire.isOffPane}`)
    .attr("d", wire.path)
    .attr("fill", "none")
    .attr(
      "style",
      styleText({
        opacity: opacityOf(wire, isLit, isDimmed),
        stroke: "var(--ink)",
        "stroke-dasharray": wire.isOffPane ? "5 4" : "none",
        "stroke-width": isLit ? "2.5" : "1.5",
        transition: "opacity var(--d-fade) ease-out, stroke-width var(--d-fade) ease-out",
      }),
    )
    .attr("data-lit", isLit ? "" : undefined)
    .attr("data-dimmed", isDimmed ? "" : undefined);
};

/**
 * One SVG over the reader's body, fixed and out of the pointer's way: a path for each link of the
 * current section whose two ends were measured. While a node is hovered the wires with both ends
 * in its chain are lit and the rest fainter.
 */
export const wiresView = (
  _h: Html.H<Message>,
  trace: Trace,
  maybeCurrent: Option.Option<PrdSectionId>,
  maybeMeasured: Option.Option<Measured>,
  maybeHovered: Option.Option<Node>,
  unfolded: Record.ReadonlyRecord<string, boolean>,
) => {
  const maybeChain = hoverChainOf(trace, maybeHovered);
  const boxes = stackBoxesOf(trace.tasks, unfolded);
  const trunks = Array.flatMap(boxes, (box) => Option.toArray(box.maybeTrunk));
  const wires = Option.match(Option.all({ current: maybeCurrent, measured: maybeMeasured }), {
    onNone: (): ReadonlyArray<Wire> => [],
    onSome: ({ current, measured }) =>
      wiresOf(
        linksOf(current, cardsOf(trace, current), endKeyInOf(boxes)),
        measured.boxes,
        measured.panes,
      ),
  });
  return svg.svg
    .attr("data-wire-layer", "")
    .attr("aria-hidden", "true")
    .attr(
      "style",
      styleText({
        height: "100%",
        inset: "0",
        overflow: "visible",
        "pointer-events": "none",
        position: "fixed",
        width: "100%",
        "z-index": "2",
      }),
    )
    .children(Array.map(wires, (wire) => wireView(wire, maybeChain, trunks)));
};
