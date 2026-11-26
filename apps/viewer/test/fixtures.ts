import { Session } from "@cairn/contract";
import { stacksOf } from "@cairn/core/stacks";
import type { View } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing";
import { Locator } from "@effect/ui/testing";
import {
  Array,
  Effect,
  RegExp as EffectRegExp,
  Option,
  Predicate,
  Record,
  Schema,
  String,
} from "effect";
import type { Html as FoldkitHtml, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../src/demo.ts";
import { Viewer, viewerBridge } from "../src/app.ts";
import { makeFoldkitBridge, type FoldkitBridge } from "../src/effect-ui/bridge.ts";
import { RenderDiff } from "../src/diff.ts";
import { PushUrl } from "../src/route.ts";
import { PressDivider } from "../src/view/dividerView.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import type { Measured } from "../src/wires.ts";
import { init } from "../src/init.ts";
import { Message } from "../src/message.ts";
import { TraceData, type Model } from "../src/model.ts";
import { FocusDetailHeading } from "../src/update.ts";

/** A fresh model holding the demo trace. */
export const loaded = modifyFields(init().model, {
  trace: () => TraceData.Success({ data: demoTrace }),
});

/**
 * The model with every stack's finished trunk unfolded, for a scene that looks at chips inside one
 * and has no use for the fold.
 */
export const unfolded = (model: Model): Model =>
  modifyFields(model, {
    reader: (reader) =>
      modifyFields(reader, {
        unfolded: () =>
          Record.fromIterableWith(stacksOf(demoTrace.tasks), (stack) => [stack.root, true]),
      }),
  });

/** What the reader's mount measures on a page with no layout: every pane empty and no wire end boxed. */
export const unmeasuredWires: Measured = {
  boxes: {},
  panes: {
    prd: { height: 0, width: 0, x: 0, y: 0 },
    spec: { height: 0, width: 0, x: 0, y: 0 },
    stacks: { height: 0, width: 0, x: 0, y: 0 },
  },
};

/** A session with one prompt, a reply and a tool turn, for the commit whose `Cairn-Session` is `id`. */
export const sessionWith = (id: string): Session =>
  Schema.decodeUnknownSync(Session)({
    format: "claude-code",
    id,
    notes: [],
    redactions: {},
    skipped: 0,
    taskId: "t1",
    turns: [
      { at: "2026-11-25T10:00:00.000Z", id: "p1", kind: "prompt", text: "Add the pane." },
      { at: "2026-11-25T10:00:01.000Z", id: "r1", kind: "reply", text: "Done." },
      {
        at: "2026-11-25T10:00:02.000Z",
        edits: [],
        failed: false,
        id: "c1",
        input: "ls",
        kind: "tool",
        name: "Bash",
        output: "a.ts",
        target: null,
      },
    ],
    version: 1,
  });

// --- The viewer under HtmlScene ---------------------------------------------------------------
//
// A Scene test starts `viewerScene(model)`, drives it with `click` and the other steps, and asserts
// with `expect(locator)`. A mount or a Command the viewer issues is answered with `mounted` and
// `resolve` on the bridge's own definitions.

/** A fresh model, as a Story on `Viewer` or a Scene starts when it is not given one. */
export const ordinary = init().model;

/** The one prop `Viewer` takes: with no address, it opens at `/`. */
export const viewerProps = { maybeUrl: Option.none() } as const;

/** The viewer's scene cursor, as a test steps it. */
export type ViewerSteps = HtmlScene.Steps<typeof Viewer>;

/** A scene on `Viewer` that starts from `model`. */
export const viewerScene = (model: Model) =>
  Effect.map(HtmlScene.make(Viewer, viewerProps), (s) => s.given(model));

/** an element's ARIA role and accessible name. */
export const byRole = HtmlLocator.role;

/** An attribute selector: `name` alone matches any value. */
export const attr = Locator.attr;

/** The elements `locator` finds inside those `container` finds. */
export const inside = Locator.inside;

/** The elements with this tag. */
export const tag = Locator.tag;

/** A `data-*` attribute selector; without `value`, any value matches. */
export const data = (name: string, value?: string) => Locator.attr(`data-${name}`, value);

/**
 * A Message from its encoded form. `foldkit/no-child-message-construction-in-root` reads a call
 * like `Message.ScrolledPrd(...)` outside a test file as a parent building a child's Message, so a
 * helper here decodes the Message, which is the same value.
 */
const messageOf = Schema.decodeSync(Message);
const scrolledPrdOf = Schema.decodeSync(Message.ScrolledPrd);
const measuredWiresOf = Schema.decodeSync(Message.MeasuredWires);

/** The reader's PRD pane found `id` at its top, as the mount reports on a page with no layout. */
export const prdScrolledTo = (id: string) => (s: ViewerSteps) =>
  s.mounted(TrackPrdScroll, scrolledPrdOf({ _tag: "ScrolledPrd", id }));

const stacksScrolledOf = Schema.decodeSync(Message.CompletedScrollStacks);

/** The stacks pane has no chart to measure. */
export const stacksScrolled = (s: ViewerSteps) =>
  s.mounted(
    ScrollStacksToBottom,
    stacksScrolledOf({ _tag: "CompletedScrollStacks", maybeChartWidth: Option.none() }),
  );

/** The wires' mount answering with what it measured. */
export const wiresMeasuredAs = (measured: Measured) => (s: ViewerSteps) =>
  s.mounted(MeasureWires, measuredWiresOf({ _tag: "MeasuredWires", measured }));

/** The three pane dividers listen for a press from the moment they render; the test acknowledges each. */
export const dividersRunning = (s: ViewerSteps) =>
  s
    .expectMount(PressDivider({ pane: "prd" }))
    .expectMount(PressDivider({ pane: "spec" }))
    .expectMount(PressDivider({ pane: "stacks" }));

/** The reader's mounts, answering as they would on a page with no layout: the PRD pane found `id` at its top, and nothing is measured or boxed. */
export const readerMountedAt = (id: string) => (s: ViewerSteps) =>
  s.pipe(dividersRunning, prdScrolledTo(id), stacksScrolled, wiresMeasuredAs(unmeasuredWires));

/** The reader's mounts with the PRD pane at `prd.goal`. */
export const readerMounted = readerMountedAt("prd.goal");

/** The history write a pin or an opened link makes, answered as the page would: it is done. */
export const pushedUrl = (s: ViewerSteps) =>
  s.resolve(viewerBridge.commandOf(PushUrl), messageOf({ _tag: "CompletedNavigation" }));

/** Answers a Foldkit Command the viewer issued with `message`. */
export const resolved =
  (definition: { readonly name: string }, message: Message) => (s: ViewerSteps) =>
    s.resolve(viewerBridge.commandOf(definition), message);

/** A RegExp for a text that contains `text`, for `toHaveText`. */
export const containing = (text: string): RegExp => new RegExp(EffectRegExp.escape(text), "u");

/**
 * A small component that hosts a Foldkit view through the bridge, for a test of a view that has
 * no place in the viewer's own screens: the state is its Model, `update` is a pure function of
 * it, and the Scene starts from a Model as props.
 */
export const hostFoldkitView = <Msg, ModelOf>(options: {
  readonly name: string;
  readonly message: Schema.Codec<Msg, unknown>;
  readonly model: Schema.Codec<ModelOf, unknown>;
  readonly mounts?: ReadonlyArray<Parameters<typeof makeFoldkitBridge<Msg>>[0]["mounts"][number]>;
  /** The bridge the view is built under, when the test asks it for `mountOf`; `mounts` is ignored then. */
  readonly bridge?: FoldkitBridge<Msg>;
  readonly update: (model: ModelOf, message: Msg) => ModelOf;
  readonly view: (model: ModelOf, h: HtmlBuilder<Msg>) => FoldkitHtml;
}) => {
  const bridge: FoldkitBridge<Msg> =
    options.bridge ??
    makeFoldkitBridge({
      message: options.message,
      mounts: options.mounts ?? [],
    });
  return Html.component({
    message: options.message,
    model: options.model,
    name: options.name,
    props: options.model,
  }).make({
    init: ($) => $.props,
    update: ($, message) => options.update($.model, message),
    view: (h, model) =>
      Option.getOrElse(
        Option.fromNullOr(
          bridge.foldkitView(
            h,
            bridge.build((foldkit) => options.view(model, foldkit)),
          ),
        ),
        () => h.span,
      ),
  });
};

/** The elements whose `class` lists `name`. */
export const withClass = (name: string): Locator.Locator => ({
  all: (root) =>
    Array.filter(Locator.elements(root), (node) =>
      Array.contains(
        String.split(
          Option.getOrElse(Option.fromNullishOr(node.attrs?.["class"]), () => ""),
          " ",
        ),
        name,
      ),
    ),
  description: `.${name}`,
});

/** The elements both locators find. */
export const both = (first: Locator.Locator, second: Locator.Locator): Locator.Locator => ({
  all: (root) => {
    const matching = second.all(root);
    return Array.filter(first.all(root), (node) => Array.contains(matching, node));
  },
  description: `${first.description}${second.description}`,
});

/** The elements whose `style` lists `name: value`. */
export const styled = (name: string, value: string): Locator.Locator => ({
  all: (root) =>
    Array.filter(Locator.elements(root), (node) =>
      Array.contains(
        String.split(
          Option.getOrElse(Option.fromNullishOr(node.attrs?.["style"]), () => ""),
          "; ",
        ),
        `${name}: ${value}`,
      ),
    ),
  description: `[style~="${name}: ${value}"]`,
});

/** A Message a stream of the viewer delivers. */
export const sent = (message: Message) => (s: ViewerSteps) => s.subscription("address", message);

/** The detail panel took focus on its heading; answers the Command that moved it. */
export const focusedHeading = (s: ViewerSteps) =>
  s.resolve(
    viewerBridge.commandOf(FocusDetailHeading),
    messageOf({ _tag: "CompletedFocusDetailHeading" }),
  );

/** The diff mount of a loaded patch answers once it has drawn the patch. */
export const drawnDiff = (s: ViewerSteps) =>
  s.mounted(RenderDiff, messageOf({ _tag: "CompletedRenderDiff" }));

/** The detail panel's divider listens for a press from the moment the panel renders. */
export const detailDividerRunning = (s: ViewerSteps) =>
  s.expectMount(PressDivider({ pane: "detail" }));

/** The elements whose attribute `name` starts with `prefix`. */
export const attrStartingWith = (name: string, prefix: string): Locator.Locator => ({
  all: (root) =>
    Array.filter(Locator.elements(root), (node) =>
      Option.exists(Option.fromNullishOr(node.attrs?.[name]), (value) =>
        String.startsWith(prefix)(value),
      ),
    ),
  description: `[${name}^="${prefix}"]`,
});

/** The first element `locator` finds: the one of several a check reads. */
export const first = (locator: Locator.Locator): Locator.Locator => ({
  all: (root) => Array.take(locator.all(root), 1),
  description: `first ${locator.description}`,
});

/** The elements `locator` finds that lack the attribute `name`. */
export const withoutAttr = (name: string, locator: Locator.Locator): Locator.Locator => ({
  all: (root) => Array.filter(locator.all(root), (node) => node.attrs?.[name] === undefined),
  description: `${locator.description}:not([${name}])`,
});

/** The `index`th element `locator` finds, in document order. */
export const nth = (locator: Locator.Locator, index: number): Locator.Locator => ({
  all: (root) => Array.take(Array.drop(locator.all(root), index), 1),
  description: `${locator.description}[${index}]`,
});

/** Applies `step` to the cursor once per item, in order. */
export const forEachStep =
  <A>(items: ReadonlyArray<A>, step: (s: ViewerSteps, item: A) => ViewerSteps) =>
  (s: ViewerSteps): ViewerSteps =>
    Array.reduce(items, s, step);

/** A `style` attribute that lists `property: value`, for `toHaveAttribute("style", ...)`. */
export const styleDeclaring = (property: string, value: string): RegExp =>
  new RegExp(`(^|; )${EffectRegExp.escape(property)}: ${EffectRegExp.escape(value)}(;|$)`, "u");

/** A text that does not contain `text`, for `toHaveText`. */
export const notContaining = (text: string): RegExp =>
  new RegExp(`^(?![\\s\\S]*${EffectRegExp.escape(text)})`, "u");

/**
 * Every Element in a rendered view that has the attribute `name` (with `value`, when given), in
 * document order. They are the view's own node objects, so two renders can be compared by
 * identity: the bridge keeps what a `createLazy` slot reused by handing back the node it
 * converted last time.
 */
export const nodesWithAttr = (
  view: View.Node<unknown, unknown>,
  name: string,
  value?: string,
): ReadonlyArray<View.Node<unknown, unknown>> => {
  const here =
    Predicate.isTagged(view, "Element") &&
    Option.exists(
      Option.fromNullishOr(view.attrs[name]),
      (found) => value === undefined || found === value,
    )
      ? [view]
      : [];
  return Array.appendAll(
    here,
    Predicate.isTagged(view, "Element")
      ? Array.flatMap(view.children, (child) => nodesWithAttr(child, name, value))
      : [],
  );
};

/** Whether two renders hold the same node objects, in order: every lazy slot reused. */
export const sameNodes = (
  before: ReadonlyArray<View.Node<unknown, unknown>>,
  after: ReadonlyArray<View.Node<unknown, unknown>>,
): boolean =>
  Array.length(before) === Array.length(after) &&
  Array.every(Array.zip(before, after), ([left, right]) => left === right);
