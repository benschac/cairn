import { decodeLink, Step, type Link } from "@cairn/contract";
import { Html } from "@effect/ui/html";
import { HtmlScene } from "@effect/ui/html/testing";
import { it } from "@effect/vitest";
import { Array, Effect, Option, Result, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { RenderDiff } from "../src/diff.ts";
import { diffPathOf, rangeOf, shortSha } from "../src/codeView.ts";
import { demoTrace } from "../src/demo.ts";
import { Message } from "../src/message.ts";
import { Screen, Shown } from "../src/model.ts";
import { openLink, update as appUpdate } from "../src/update.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import {
  byRole,
  containing,
  data,
  inside,
  loaded,
  readerMounted,
  viewerScene,
  type ViewerSteps,
} from "./fixtures.ts";
import { noticeOf, resolveLink, type Loaded } from "../src/links.ts";
import { linkNoticeView } from "../src/view/linkNoticeView.ts";

const NOTHING_LOADED: Loaded = { isDemo: false, patches: {}, sessions: {} };

/** The notice a path opens with over the demo trace, when it has one. */
const noticeFor = (path: string): Option.Option<string> =>
  noticeOf(Result.map(decodeLink(path), (link) => resolveLink(demoTrace, link, NOTHING_LOADED)));

/** A component with nothing but the notice, as the reader and the code view hold it. */
const NoticeMessage = defineMessageUnion({ ClickedDismissLinkNotice: {} });
type NoticeMessage = typeof NoticeMessage.Type;

const NoticeModel = Schema.Struct({ maybeNotice: Schema.Option(Schema.String) });
type NoticeModel = typeof NoticeModel.Type;

const view = (h: Html.H<NoticeMessage>, model: NoticeModel) =>
  h.main.children(
    Option.getOrUndefined(
      Option.map(model.maybeNotice, (text) =>
        linkNoticeView(h, text, { onDismiss: NoticeMessage.ClickedDismissLinkNotice() }),
      ),
    ),
  );

const Notice = Html.component({
  message: NoticeMessage,
  model: NoticeModel,
  name: "Notice",
  props: NoticeModel,
}).make({
  init: ($) => $.props,
  update: (): NoticeModel => ({ maybeNotice: Option.none() }),
  view,
});

const opened = (path: string) => HtmlScene.make(Notice, { maybeNotice: noticeFor(path) });

const notice = byRole("status");
const dismiss = byRole("button", { name: "Dismiss" });

it.effect("a link to a missing task says how far it opened and which task is gone", () =>
  Effect.gen(function* () {
    const s = yield* opened("/section/prd.deep-links/task/t999");
    s.expect(notice).toHaveText(
      containing("Opened as far as section prd.deep-links. No task t999 in the trace."),
    );
  }),
);

it.effect("a path that is not a link opens nothing and says why", () =>
  Effect.gen(function* () {
    const s = yield* opened("/task/t1/file/x.ts");
    s.expect(notice).toHaveText(
      containing(
        "This address is not a Cairn link: step 1 (file): must follow a diff or a commit.",
      ),
    );
  }),
);

it.effect("Dismiss removes the notice", () =>
  Effect.gen(function* () {
    const s = yield* opened("/task/t999");
    s.expect(notice)
      .toHaveText(containing("Nothing in this link opened. No task t999 in the trace."))
      .click(dismiss)
      .expect(notice)
      .toBeAbsent();
  }),
);

it.effect("a link that opens whole shows no notice", () =>
  Effect.gen(function* () {
    const s = yield* opened("/section/prd.deep-links/task/t1");
    s.expect(notice).toBeAbsent();
  }),
);

// THE APP: the notice in the reader and in the code view

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

const appNotice = data("link-notice");
const appDismiss = inside(appNotice, dismiss);

/** The diff mount of a loaded patch answers once it has drawn it. */
const drawn = (s: ViewerSteps) => s.mounted(RenderDiff, Message.CompletedRenderDiff());

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

it.effect(
  "the reader shows the notice of a link that did not open whole, and Dismiss takes it away",
  () =>
    Effect.gen(function* () {
      const s = yield* viewerScene(linked(toMissingTask));
      s.pipe(readerMounted)
        .expect(appNotice)
        .toHaveText(containing("No task t999 in the trace."))
        .click(appDismiss)
        .expect(appNotice)
        .toBeAbsent();
    }),
);

it.effect(
  "the code view shows the notice of a link that did not open whole, and Dismiss takes it away",
  () =>
    Effect.gen(function* () {
      const waiting = linked(toMissingFile);
      const withPatch = appUpdate(
        waiting,
        Message.ReceivedPatch({
          path: diffPathOf(base, head),
          result: Result.succeed(commitPatch),
        }),
      ).model;
      const s = yield* viewerScene(withPatch);
      s.pipe(drawn)
        .expect(appNotice)
        .toHaveText(containing("no/such/file.ts"))
        .click(appDismiss)
        .expect(appNotice)
        .toBeAbsent();
    }),
);

it.effect("a reader with no link opened shows no notice", () =>
  Effect.gen(function* () {
    const s = yield* viewerScene(modifyFields(loaded, { screen: () => Screen.Reader() }));
    s.pipe(readerMounted).expect(appNotice).toBeAbsent();
  }),
);

// THE CODE VIEW'S HEADER AT AN OLDER HEAD

const stacked = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (candidate) => Array.length(candidate.commits) >= 2),
);
const oldest = Option.getOrThrow(Array.head(stacked.commits));
const oldestBase = Option.getOrThrow(Array.head(oldest.parents));

it.effect("the code view's header counts and ranges the commits up to the head a link names", () =>
  Effect.gen(function* () {
    const whole = codeModel(Shown.WholeTask({ maybeHead: Option.none() }));
    const atOldest = codeModel(Shown.WholeTask({ maybeHead: Option.some(oldest.sha) }));
    const s = yield* viewerScene(whole);
    s.expect(data("shown"))
      .toHaveText(containing(`${Array.length(stacked.commits)} commits`))
      .given(atOldest)
      .expect(data("shown"))
      .toHaveText(containing(`1 commit ${shortSha(oldestBase)}..${shortSha(oldest.sha)}`));
  }),
);
