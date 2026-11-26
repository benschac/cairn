import { PrdSectionId } from "@cairn/contract";
import type { View } from "@effect/ui";
import { Html, HtmlServer } from "@effect/ui/html";
import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing";
import { Locator } from "@effect/ui/testing";
import { assert, it } from "@effect/vitest";
import { Array, Effect, Option, Predicate, Schema, String, pipe } from "effect";
import { renderToString } from "foldkit/experimental/server";
import type { Html as FoldkitHtml, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { demoTrace } from "../../src/demo.ts";
import { DrawDiagram } from "../../src/diagram.ts";
import { RenderDiff } from "../../src/diff.ts";
import { makeFoldkitBridge, type FoldkitBridge } from "../../src/effect-ui/bridge.ts";
import { Message } from "../../src/message.ts";
import { Screen } from "../../src/model.ts";
import { linkNoticeView } from "../../src/view/linkNoticeView.ts";
import { TrackPrdScroll, prdPaneView } from "../../src/view/prdPaneView.ts";
import { ScrollStacksToBottom } from "../../src/view/stackChipsView.ts";
import { view as viewerView } from "../../src/view/view.ts";
import { MeasureWires } from "../../src/view/wiresView.ts";
import { loaded } from "../fixtures.ts";

// Each view is rendered twice: by Foldkit, as the viewer renders it today, and by Effect UI
// through the bridge. Each side's own server render turns its tree into HTML, so the comparison
// does not run through the bridge's idea of the DOM. Then a click on a bridged button has to
// send the Message the Foldkit button sends.

// --- the DOM, both ways ------------------------------------------------------------------

/**
 * HTML as a list of tokens that two serializers agree on when the DOM is the same: comments
 * dropped (Effect UI marks each instance with them), a tag's attributes sorted, `name=""` written
 * `name`, a `style`'s declarations as `property:value`, and `>` unescaped, which Foldkit leaves
 * bare in an attribute and Effect UI writes `&gt;`.
 */
const tokensOf = (html: string): ReadonlyArray<string> =>
  pipe(
    Array.fromIterable(String.matchAll(/<!--[\s\S]*?-->|<(?:[^>"]|"[^"]*")+>|[^<]+/gu)(html)),
    Array.map(([token]) => String.replaceAll("&gt;", ">")(token)),
    Array.filter((token) => !String.startsWith("<!--")(token)),
    Array.map((token) => (String.startsWith("<")(token) ? tagOf(token) : token)),
  );

const styleOf = (value: string): string =>
  pipe(
    String.split(value, ";"),
    Array.map((declaration) => pipe(declaration, String.replaceAll(/\s*:\s*/gu, ":"), String.trim)),
    Array.filter(String.isNonEmpty),
    Array.join(";"),
  );

const tagOf = (token: string): string => {
  const [, close = "", name = "", rest = ""] = Option.getOrElse(
    Option.fromNullOr(/^<(\/?)([^\s/>]+)([\s\S]*?)\/?>$/u.exec(token)),
    () => [],
  );
  const attributes = pipe(
    Array.fromIterable(String.matchAll(/([^\s=]+)(?:="([^"]*)")?/gu)(rest)),
    Array.map(([, attribute = "", value = ""]) =>
      String.isEmpty(value)
        ? attribute
        : `${attribute}="${attribute === "style" ? styleOf(value) : value}"`,
    ),
    (sorted) => Array.sort(sorted, String.Order),
  );
  return `<${close}${Array.join(Array.prepend(attributes, name), " ")}>`;
};

/** A Foldkit view's HTML, from Foldkit's own server render. */
const foldkitHtmlOf = <M>(view: (h: HtmlBuilder<M>) => FoldkitHtml) =>
  Effect.map(
    renderToString(
      {
        init: () => ({ commands: [], model: {} }),
        view: (_model: {}, h: HtmlBuilder<M>) => ({ body: view(h), title: "" }),
      },
      { isHydratable: false },
    ),
    (rendered) => rendered.html,
  );

// --- the views -----------------------------------------------------------------------------

/** What the component last received, as JSON, so a test reads it off the view. */
const sentText = Schema.encodeSync(Schema.fromJsonString(Message));

const NoticeMessage = defineMessageUnion({ ClickedDismissLinkNotice: {} });
type NoticeMessage = typeof NoticeMessage.Type;
const noticeSentText = Schema.encodeSync(Schema.fromJsonString(NoticeMessage));

const notice = (h: HtmlBuilder<NoticeMessage>): FoldkitHtml =>
  linkNoticeView("Opened the section; task t999 is not in this plan.", h, {
    onDismiss: NoticeMessage.ClickedDismissLinkNotice(),
  });

const prdPane = (h: HtmlBuilder<Message>): FoldkitHtml =>
  prdPaneView(
    demoTrace,
    Option.none(),
    loaded.reader.maybePinned,
    loaded.reader.isPrdCondensed,
    loaded.reader.prdOpened,
    loaded.maybeCopied,
    loaded.maybeCopiedLink,
    "",
    loaded.search.results,
    loaded.search.maybeActive,
    loaded.reader.maybePassage,
    "",
    false,
    loaded.readers,
    h,
  );

const noticeBridge = makeFoldkitBridge({ message: NoticeMessage, mounts: [] });
/** Every Foldkit Mount the viewer issues, which is what the host step's bridge will be given. */
const viewerBridge = makeFoldkitBridge({
  message: Message,
  mounts: [DrawDiagram, MeasureWires, RenderDiff, ScrollStacksToBottom, TrackPrdScroll],
});

/** The whole reader screen, the body of the viewer's `view`, as the host step will bridge it. */
const reading = modifyFields(loaded, { screen: () => Screen.Reader() });
const reader = (h: HtmlBuilder<Message>): FoldkitHtml => viewerView(reading, h).body;

/**
 * A component whose view is a Foldkit view through the bridge, over a line that shows the last
 * Message it received.
 */
const bridged = <M>(
  name: string,
  message: Schema.Codec<M, unknown>,
  bridge: FoldkitBridge<M>,
  view: (h: HtmlBuilder<M>) => FoldkitHtml,
  textOf: (message: M) => string,
) =>
  Html.component({
    message,
    model: Schema.Struct({ sent: Schema.String }),
    name,
  }).make({
    init: () => ({ sent: "" }),
    update: ($, received) => ({ sent: textOf(received) }),
    view: (h, model) =>
      h.div.children(
        bridge.foldkitView(h, bridge.build(view)),
        h.p.id("sent").children(model.sent),
      ),
  });

const BridgedNotice = bridged("Notice", NoticeMessage, noticeBridge, notice, noticeSentText);
const BridgedPrdPane = bridged("PrdPane", Message, viewerBridge, prdPane, sentText);
const BridgedReader = bridged("Reader", Message, viewerBridge, reader, sentText);

/** The bridged component's HTML, from Effect UI's server render, without the line it adds. */
const effectUiHtmlOf = (rendered: Effect.Effect<{ readonly html: string }>) =>
  Effect.map(rendered, ({ html }) =>
    pipe(
      html,
      String.replace(/<p id="sent"><\/p><\/div>(<!--[^>]*-->)?$/u, ""),
      String.replace(/^(<!--[^>]*-->)?<div>/u, ""),
    ),
  );

it.effect("the link notice renders the same DOM through the bridge as through Foldkit", () =>
  Effect.gen(function* () {
    const foldkit = yield* foldkitHtmlOf(notice);
    const effectUi = yield* effectUiHtmlOf(HtmlServer.renderToHtml(BridgedNotice, {}));
    assert.isTrue(String.includes("Dismiss")(foldkit));
    assert.deepStrictEqual(tokensOf(effectUi), tokensOf(foldkit));
  }),
);

it.effect("the PRD pane renders the same DOM through the bridge as through Foldkit", () =>
  Effect.gen(function* () {
    const foldkit = yield* foldkitHtmlOf(prdPane);
    const effectUi = yield* effectUiHtmlOf(HtmlServer.renderToHtml(BridgedPrdPane, {}));
    assert.isAbove(Array.length(tokensOf(foldkit)), 1000);
    assert.deepStrictEqual(tokensOf(effectUi), tokensOf(foldkit));
  }),
);

it.effect(
  "the whole reader screen renders the same DOM through the bridge as through Foldkit",
  () =>
    Effect.gen(function* () {
      const foldkit = yield* foldkitHtmlOf(reader);
      const effectUi = yield* effectUiHtmlOf(HtmlServer.renderToHtml(BridgedReader, {}));
      assert.isAbove(Array.length(tokensOf(foldkit)), 10_000);
      assert.deepStrictEqual(tokensOf(effectUi), tokensOf(foldkit));
    }),
);

// --- a click, both ways ------------------------------------------------------------------

const sent = Locator.attr("id", "sent");
const dismiss = HtmlLocator.role("button", { name: "Dismiss" });
const goal = PrdSectionId.make("prd.goal");
const viewerSection = PrdSectionId.make("prd.viewer");

it.effect("a click on the bridged Dismiss sends the Message the Foldkit button sends", () =>
  Effect.gen(function* () {
    const expected = noticeSentText(NoticeMessage.ClickedDismissLinkNotice());
    const s = yield* HtmlScene.make(BridgedNotice, {});
    s.click(dismiss).expect(sent).toHaveText(expected);
  }),
);

it.effect(
  "a click on a bridged status line sends the Message the Foldkit one sends, and the pane's Mount runs",
  () =>
    Effect.gen(function* () {
      const expected = sentText(Message.ClickedStatusLine({ id: viewerSection }));
      const s = yield* HtmlScene.make(BridgedPrdPane, {});
      s.mounted(viewerBridge.mountOf(TrackPrdScroll), Message.ScrolledPrd({ id: goal }))
        .expect(sent)
        .toHaveText(sentText(Message.ScrolledPrd({ id: goal })))
        .click(Locator.attr("data-status-line", viewerSection))
        .expect(sent)
        .toHaveText(expected);
    }),
);

/** An element's first child, and the PRD pane's body under the bridged component's root. */
const childOf = <R>(node: View.Node<Message, R>) =>
  Predicate.isTagged(node, "Element") ? Array.head(node.children) : Option.none();
const bodyOf = <R>(view: View.Node<Message, R>) =>
  Option.getOrThrow(Option.flatMap(childOf(view), childOf));

it.effect(
  "a render whose PRD pane did not change converts it to the same nodes as the last one",
  () =>
    Effect.gen(function* () {
      // The pane's root is built again each render; the body under it is Foldkit's `createLazy`, so
      // a second render hands the bridge the same VNode and gets back the same Effect UI node.
      const s = yield* HtmlScene.make(BridgedPrdPane, {});
      const before = s.view;
      s.mounted(viewerBridge.mountOf(TrackPrdScroll), Message.ScrolledPrd({ id: goal }));
      const after = s.view;
      assert.notStrictEqual(before, after);
      assert.strictEqual(bodyOf(after), bodyOf(before));
    }),
);
