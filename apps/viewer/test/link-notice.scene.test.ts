import { decodeLink, PrdSectionId, Step, type Link } from "@cairn/contract";
import { it } from "@effect/vitest";
import { Array, Option, Result, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { Mount, click, expect, given, role, scene, selector, within } from "foldkit/scene";
import { modifyFields } from "foldkit/struct";

import { RenderDiff } from "../src/diff.ts";
import { diffPathOf, rangeOf, shortSha } from "../src/codeView.ts";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen, Shown } from "../src/model.ts";
import { ScrollStacksToBottom } from "../src/view/stackChipsView.ts";
import { MeasureWires } from "../src/view/wiresView.ts";
import { TrackPrdScroll } from "../src/view/prdPaneView.ts";
import { openLink, update as appUpdate } from "../src/update.ts";
import { view as appView } from "../src/view/view.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import { loaded, unmeasuredWires } from "./fixtures.ts";
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

// THE APP: the notice in the reader and in the code view

const app = { update: appUpdate, view: appView };
const decodeStep = Schema.decodeUnknownSync(Step);

const task = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (candidate) => Option.isSome(rangeOf(candidate))),
);
const { base, head } = Option.getOrThrow(rangeOf(task));

/** A link to a task that is not in the trace: the reader opens, the task is missing. */
const toMissingTask: Link = [decodeStep({ id: "t999", kind: "task" })];

/** A link to a file the task's diff does not hold: the code view opens, the file is missing. */
const toMissingFile: Link = Array.map(
  [
    { kind: "task", id: task.id },
    { kind: "diff", head },
    { kind: "file", path: "no/such/file.ts" },
  ],
  (step) => decodeStep(step),
);

const appNotice = selector("[data-link-notice]");
const appDismiss = within(appNotice, dismiss);

/** The diff mount of a loaded patch answers once it has drawn it. */
const drawn = Mount.resolve(
  RenderDiff,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedRenderDiff(),
);

const readerMounted = Mount.resolveAll(
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [TrackPrdScroll, Message.ScrolledPrd({ id: PrdSectionId.make("prd.goal") })],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [ScrollStacksToBottom, Message.CompletedScrollStacks({ maybeChartWidth: Option.none() })],
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  [MeasureWires, Message.MeasuredWires({ measured: unmeasuredWires })],
);

const codeModel = (shown: Shown) =>
  modifyFields(loaded, {
    screen: () =>
      Screen.Code({
        maybeFile: Option.none(),
        maybeLines: Option.none(),
        shown,
        taskId: stacked.id,
      }),
  });

const linked = (link: Link) => openLink(loaded, link).model;

it("the reader shows the notice of a link that did not open whole, and Dismiss takes it away", () => {
  scene(
    app,
    given(linked(toMissingTask)),
    readerMounted,
    expect(appNotice).toContainText("No task t999 in the trace."),
    click(appDismiss),
    expect(appNotice).toBeAbsent(),
  );
});

it("the code view shows the notice of a link that did not open whole, and Dismiss takes it away", () => {
  const waiting = linked(toMissingFile);
  const withPatch = appUpdate(
    waiting,
    Message.ReceivedPatch({ path: diffPathOf(base, head), result: Result.succeed(commitPatch) }),
  ).model;
  scene(
    app,
    given(withPatch),
    drawn,
    expect(appNotice).toContainText("no/such/file.ts"),
    click(appDismiss),
    expect(appNotice).toBeAbsent(),
  );
});

it("a reader with no link opened shows no notice", () => {
  scene(
    app,
    given(modifyFields(loaded, { screen: () => Screen.Reader() })),
    readerMounted,
    expect(appNotice).toBeAbsent(),
  );
});

// THE CODE VIEW'S HEADER AT AN OLDER HEAD

const stacked = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (candidate) => Array.length(candidate.commits) >= 2),
);
const oldest = Option.getOrThrow(Array.head(stacked.commits));
const oldestBase = Option.getOrThrow(Array.head(oldest.parents));

it("the code view's header counts and ranges the commits up to the head a link names", () => {
  const whole = codeModel(Shown.WholeTask({ maybeHead: Option.none() }));
  const atOldest = codeModel(Shown.WholeTask({ maybeHead: Option.some(oldest.sha) }));
  scene(
    app,
    given(whole),
    expect(selector("[data-shown]")).toContainText(`${Array.length(stacked.commits)} commits`),
    given(atOldest),
    expect(selector("[data-shown]")).toContainText(
      `1 commit ${shortSha(oldestBase)}..${shortSha(oldest.sha)}`,
    ),
  );
});
