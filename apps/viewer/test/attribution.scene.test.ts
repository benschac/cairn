import { Session } from "@cairn/contract";
import { expect as assert, it } from "@effect/vitest";
import { Array, Option, Record, Result, Schema } from "effect";
import { Mount, click, expect, given, scene, selector } from "foldkit/scene";
import { Command, given as storyGiven, message, model, story } from "foldkit/story";

import { patchPathOf } from "../src/codeView.ts";
import { ScrollTurn } from "../src/command.ts";
import { demoTrace } from "../src/demo.ts";
import { RenderDiff } from "../src/diff.ts";
import { Message } from "../src/message.ts";
import { Shown, type Model } from "../src/model.ts";
import { update as appUpdate } from "../src/update.ts";
import { view as appView } from "../src/view/view.ts";
import commitPatch from "./fixtures/commit.patch?raw";
import { loaded } from "./fixtures.ts";

/** A task with a commit that has a session, so the code view on it marks the diff's hunks. */
const task = Option.getOrThrow(
  Array.findFirst(demoTrace.tasks, (each) =>
    Array.some(each.commits, (commit) => commit.session !== null),
  ),
);
const commit = Option.getOrThrow(Array.findFirst(task.commits, (each) => each.session !== null));
const sessionId = `${commit.session}`;
const patchPath = Option.getOrThrow(patchPathOf(task, Shown.OneCommit({ sha: commit.sha })));

const tool = (id: string, path: string, added: ReadonlyArray<string>) => ({
  at: "2026-11-25T10:00:02.000Z",
  edits: [{ added, path, removed: [] }],
  failed: false,
  id,
  input: "the edit's input",
  kind: "tool",
  name: "Edit",
  output: "The file has been updated.",
  target: path,
});

const session = Schema.decodeUnknownSync(Session)({
  format: "claude-code",
  id: sessionId,
  notes: [],
  redactions: {},
  skipped: 0,
  taskId: "t1",
  turns: [
    { at: "2026-11-25T10:00:00.000Z", id: "p1", kind: "prompt", text: "Add the events." },
    tool("c1", "packages/contract/src/events.ts", ["export const Actor = Schema.Union(["]),
    tool("c2", "packages/contract/src/index.ts", ['export * from "./events.ts";']),
  ],
  version: 1,
});

const app = { update: appUpdate, view: appView };

const after = (start: Model, ...messages: ReadonlyArray<Message>): Model =>
  Array.reduce(messages, start, (current, next) => appUpdate(current, next).model);

/** The code view on the commit with its patch and its session loaded. */
const showing = after(
  loaded,
  Message.ClickedOpenCode({ id: task.id, maybeSha: Option.some(commit.sha) }),
  Message.ReceivedPatch({ path: patchPath, result: Result.succeed(commitPatch) }),
  Message.ReceivedSession({ id: sessionId, result: Result.succeed(session) }),
);

const list = selector("[data-patch-path]");
const turn = (id: string) => selector(`li[data-turn="${id}"]`);
const turnButton = (id: string) => selector(`li[data-turn="${id}"] button[aria-expanded]`);
const drawn = Mount.resolve(
  RenderDiff,
  // oxlint-disable-next-line foldkit/no-child-message-construction-in-root -- src/message.ts is the root Message; the rule reads a path into src/ as a child module
  Message.CompletedRenderDiff(),
);

it("ClickedHunkMark opens the turn, marks it from the diff side and scrolls the session to it", () => {
  story(
    appUpdate,
    storyGiven(showing),
    message(Message.ClickedHunkMark({ id: "c1" })),
    Command.expectExact(ScrollTurn({ id: "c1" })),
    Command.resolve(ScrollTurn, Message.CompletedScrollTurn()),
    model((next) => {
      assert(next.maybeHighlightedTurn).toEqual(Option.some({ from: "diff", id: "c1" }));
      assert(Record.get(next.openedTurns, "c1")).toEqual(Option.some(true));
    }),
  );
});

it("after ClickedHunkMark the session pane shows the turn open and active, and the diff its hunks", () => {
  scene(
    app,
    given(after(showing, Message.ClickedHunkMark({ id: "c1" }))),
    drawn,
    expect(turn("c1")).toHaveAttr("data-active", ""),
    expect(turnButton("c1")).toHaveAttr("aria-expanded", "true"),
    expect(selector('li[data-turn="c1"] [data-turn-part="Input"]')).toContainText(
      "the edit's input",
    ),
    expect(turn("c2")).not.toHaveAttr("data-active"),
    expect(list).toHaveAttr("data-turn", "c1"),
    expect(list).toHaveAttr("data-turn-from", "diff"),
  );
});

it("the diff mount is given the session, so it can mark each hunk with its turns", () => {
  scene(
    app,
    given(showing),
    Mount.expectExact(RenderDiff({ session: Option.some(session), text: commitPatch })),
    drawn,
    expect(list).not.toHaveAttr("data-turn"),
  );
});

it("opening a turn in the session pane marks its hunks from the session side; closing it clears them", () => {
  scene(
    app,
    given(showing),
    drawn,
    click(turnButton("c2")),
    expect(list).toHaveAttr("data-turn", "c2"),
    expect(list).toHaveAttr("data-turn-from", "session"),
    expect(turn("c2")).toHaveAttr("data-active", ""),
    click(turnButton("c2")),
    expect(list).not.toHaveAttr("data-turn"),
    expect(list).not.toHaveAttr("data-turn-from"),
    expect(turn("c2")).not.toHaveAttr("data-active"),
  );
});

it("closing a turn that is not the marked one leaves the marks alone", () => {
  scene(
    app,
    given(after(showing, Message.ClickedTurn({ id: "c1" }), Message.ClickedTurn({ id: "c2" }))),
    drawn,
    expect(list).toHaveAttr("data-turn", "c2"),
    click(turnButton("c1")),
    expect(turnButton("c1")).toHaveAttr("aria-expanded", "false"),
    expect(list).toHaveAttr("data-turn", "c2"),
    expect(turn("c2")).toHaveAttr("data-active", ""),
  );
});
