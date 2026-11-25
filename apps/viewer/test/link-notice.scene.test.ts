import { decodeLink } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Option, Result, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { click, expect, given, role, scene } from "foldkit/scene";

import { demoTrace } from "../src/demo.ts";
import { noticeOf, resolveLink, type Loaded } from "../src/links.ts";
import { linkNoticeView } from "../src/view/linkNoticeView.ts";

const NOTHING_LOADED: Loaded = { isDemo: false, patches: {}, sessions: {} };

/** The notice a path opens with over the demo trace, when it has one. */
const noticeFor = (path: string): Option.Option<string> =>
  noticeOf(Result.map(decodeLink(path), (link) => resolveLink(demoTrace, link, NOTHING_LOADED)));

/** A program with nothing but the notice, as the reader and the code view hold it. */
const NoticeMessage = defineMessageUnion({ ClickedDismissLinkNotice: {} });
type NoticeMessage = typeof NoticeMessage.Type;

const NoticeModel = Schema.Struct({ maybeNotice: Schema.Option(Schema.String) });
type NoticeModel = typeof NoticeModel.Type;

const view = (model: NoticeModel, h: HtmlBuilder<NoticeMessage>): Html =>
  h.main(
    [],
    Option.match(model.maybeNotice, {
      onNone: () => [],
      onSome: (text) => [
        linkNoticeView(text, h, { onDismiss: NoticeMessage.ClickedDismissLinkNotice() }),
      ],
    }),
  );

const update = (_model: NoticeModel, _message: NoticeMessage) => ({
  model: { maybeNotice: Option.none() },
});

const opened = (path: string) => given<NoticeModel>({ maybeNotice: noticeFor(path) });

const notice = role("status");
const dismiss = role("button", { name: "Dismiss" });

it("a link to a missing task says how far it opened and which task is gone", () => {
  scene(
    { update, view },
    opened("/section/prd.deep-links/task/t999"),
    expect(notice).toContainText(
      "Opened as far as section prd.deep-links. No task t999 in the trace.",
    ),
  );
});

it("a path that is not a link opens nothing and says why", () => {
  scene(
    { update, view },
    opened("/task/t1/file/x.ts"),
    expect(notice).toContainText(
      "This address is not a Cairn link: step 1 (file): must follow a diff or a commit.",
    ),
  );
});

it("Dismiss removes the notice", () => {
  scene(
    { update, view },
    opened("/task/t999"),
    expect(notice).toContainText("Nothing in this link opened. No task t999 in the trace."),
    click(dismiss),
    expect(notice).toBeAbsent(),
  );
});

it("a link that opens whole shows no notice", () => {
  scene({ update, view }, opened("/section/prd.deep-links/task/t1"), expect(notice).toBeAbsent());
});
