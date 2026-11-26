import { SectionId } from "@cairn/contract";
import { Html, HtmlServer } from "@effect/ui/html";
import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing";
import { Locator } from "@effect/ui/testing";
import { assert, it } from "@effect/vitest";
import { Array, Effect, Option, Schema, String, pipe } from "effect";
import { renderToString } from "foldkit/experimental/server";
import type { Html as FoldkitHtml, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";

import { demoTrace } from "../../src/demo.ts";
import { DrawDiagram } from "../../src/diagram.ts";
import { makeFoldkitBridge, type FoldkitBridge } from "../../src/effect-ui/bridge.ts";
import { Message } from "../../src/message.ts";
import { documentOf, renderSection, renderSectionTitle } from "../../src/markdown.ts";
import { linkNoticeView } from "../../src/foldkit/linkNoticeView.ts";

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
const NoticeMessage = defineMessageUnion({ ClickedDismissLinkNotice: {} });
type NoticeMessage = typeof NoticeMessage.Type;
const noticeSentText = Schema.encodeSync(Schema.fromJsonString(NoticeMessage));

const notice = (h: HtmlBuilder<NoticeMessage>): FoldkitHtml =>
  linkNoticeView("Opened the section; task t999 is not in this plan.", h, {
    onDismiss: NoticeMessage.ClickedDismissLinkNotice(),
  });

const noticeBridge = makeFoldkitBridge({ message: NoticeMessage, mounts: [] });
/** Every Foldkit Mount the viewer issues, which is what the host step's bridge will be given. */
const viewerBridge = makeFoldkitBridge({
  message: Message,
  mounts: [DrawDiagram],
});

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

const markdownDocument = documentOf(demoTrace.prd.markdown);
const markdownSection = SectionId.make("prd.viewer");

/** A section's title and prose, as Foldkit renders them. */
const markdownSectionView = (h: HtmlBuilder<Message>): FoldkitHtml =>
  h.div(
    [],
    [
      h.h2([], renderSectionTitle(markdownDocument, markdownSection, h)),
      renderSection(markdownDocument, markdownSection, h),
    ],
  );

/** The same, as an Effect UI view calls for markdown: `bridgedAll` for the title, `bridged` for the prose. */
const BridgedMarkdown = Html.component({
  message: Message,
  model: Schema.Struct({}),
  name: "Markdown",
}).make({
  init: () => ({}),
  update: () => ({}),
  view: (h) =>
    viewerBridge.render(() =>
      h.div.children(
        h.div.children(
          h.h2.children(
            viewerBridge.bridgedAll(h, (foldkit) =>
              renderSectionTitle(markdownDocument, markdownSection, foldkit),
            ),
          ),
          viewerBridge.bridged(h, (foldkit) =>
            renderSection(markdownDocument, markdownSection, foldkit),
          ),
        ),
        h.p.id("sent"),
      ),
    ),
});

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

it.effect("a section's markdown renders the same DOM through the bridge as through Foldkit", () =>
  Effect.gen(function* () {
    const foldkit = yield* foldkitHtmlOf(markdownSectionView);
    const effectUi = yield* effectUiHtmlOf(HtmlServer.renderToHtml(BridgedMarkdown, {}));
    assert.isAbove(Array.length(tokensOf(foldkit)), 20);
    assert.deepStrictEqual(tokensOf(effectUi), tokensOf(foldkit));
  }),
);

// --- a click, both ways ------------------------------------------------------------------

const sent = Locator.attr("id", "sent");
const dismiss = HtmlLocator.role("button", { name: "Dismiss" });

it.effect("a click on the bridged Dismiss sends the Message the Foldkit button sends", () =>
  Effect.gen(function* () {
    const expected = noticeSentText(NoticeMessage.ClickedDismissLinkNotice());
    const s = yield* HtmlScene.make(BridgedNotice, {});
    s.click(dismiss).expect(sent).toHaveText(expected);
  }),
);
